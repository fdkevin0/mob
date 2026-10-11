package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type Config struct {
	Transport      http.RoundTripper `json:"-"`
	Enabled        bool              `json:"enabled"`
	UseForChat     bool              `json:"useForChat"`
	AccountID      string            `json:"accountId"`
	Token          string            `json:"token,omitempty"`
	HasToken       bool              `json:"hasToken,omitempty"`
	Model          string            `json:"model"`
	EmbeddingModel string            `json:"embeddingModel"`
	Index          string            `json:"index"`
	DatabaseID     string            `json:"databaseId"`
	NamespaceID    string            `json:"namespaceId"`
	Bucket         string            `json:"bucket"`
	AccessKey      string            `json:"accessKey,omitempty"`
	SecretKey      string            `json:"secretKey,omitempty"`
	HasSecretKey   bool              `json:"hasSecretKey,omitempty"`
}

var accountID = regexp.MustCompile(`^[a-fA-F0-9]{32}$`)
var resource = regexp.MustCompile(`^[a-zA-Z0-9_@.:-]+$`)

func (c Config) Validate() error {
	if !c.Enabled {
		return nil
	}
	if !accountID.MatchString(c.AccountID) || c.Token == "" || strings.ContainsAny(c.Token, " \r\n\t") {
		return errors.New("Cloudflare: valid account ID and API token required")
	}
	if c.UseForChat && !validModel(c.Model) {
		return errors.New("Cloudflare: choose a Workers AI chat model")
	}
	for _, id := range []string{c.Index, c.DatabaseID, c.NamespaceID, c.Bucket} {
		if id != "" && (!resource.MatchString(id) || id == "." || id == "..") {
			return errors.New("Cloudflare: invalid resource name or ID")
		}
	}
	return nil
}
func (c Config) Public() Config {
	c.HasToken = c.Token != ""
	c.HasSecretKey = c.SecretKey != ""
	c.Token = ""
	c.SecretKey = ""
	return c
}
func (c Config) BaseURL() string {
	return "https://api.cloudflare.com/client/v4/accounts/" + c.AccountID
}
func (c Config) request(ctx context.Context, method, path string, body any, raw bool) (json.RawMessage, error) {
	var b []byte
	var err error
	if body != nil {
		b, err = json.Marshal(body)
		if err != nil {
			return nil, err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL()+path, bytes.NewReader(b))
	if err != nil {
		return nil, errors.New("Cloudflare: invalid request")
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")
	client := http.Client{Transport: c.Transport, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return nil, errors.New("Cloudflare connection failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("Cloudflare HTTP %d; check token permissions and resource IDs", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, (2<<20)+1))
	if err != nil || len(data) > 2<<20 {
		return nil, errors.New("Cloudflare response exceeds 2 MiB or is incomplete")
	}
	if raw {
		return json.Marshal(map[string]string{"value": string(data)})
	}
	var envelope struct {
		Success bool            `json:"success"`
		Result  json.RawMessage `json:"result"`
	}
	if json.Unmarshal(data, &envelope) != nil || !envelope.Success {
		return nil, errors.New("Cloudflare returned an unsuccessful response")
	}
	return envelope.Result, nil
}
func (c Config) Test(ctx context.Context) (json.RawMessage, error) {
	// Account-owned and user-owned tokens have different verification endpoints.
	result, err := c.request(ctx, "GET", "/tokens/verify", nil, false)
	if err == nil {
		var status struct {
			Status string `json:"status"`
		}
		if json.Unmarshal(result, &status) != nil || status.Status != "active" {
			return nil, errors.New("Cloudflare token is inactive")
		}
		return result, nil
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://api.cloudflare.com/client/v4/user/tokens/verify", nil)
	req.Header.Set("Authorization", "Bearer "+c.Token)
	cl := http.Client{Transport: c.Transport, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, e := cl.Do(req)
	if e != nil {
		return nil, errors.New("Cloudflare token verification failed")
	}
	defer resp.Body.Close()
	var data struct {
		Success bool `json:"success"`
		Result  struct {
			Status string `json:"status"`
		} `json:"result"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 65536)).Decode(&data) != nil || !data.Success || data.Result.Status != "active" {
		return nil, errors.New("Cloudflare token is invalid or inactive")
	}
	return json.Marshal(data.Result)
}

type Action struct {
	Operation string `json:"operation"`
	Text      string `json:"text"`
	Key       string `json:"key"`
	Cursor    string `json:"cursor"`
	SQL       string `json:"sql"`
	Params    []any  `json:"params"`
}

// Do is the advanced HTTP panel adapter. Application code uses typed methods.
func (c Config) Do(ctx context.Context, a Action) (any, error) {
	if path := map[string]string{
		"ai.models":         "/ai/models/search",
		"vectorize.indexes": "/vectorize/v2/indexes",
		"d1.databases":      "/d1/database",
		"kv.namespaces":     "/storage/kv/namespaces",
		"r2.buckets":        "/r2/buckets",
	}[a.Operation]; path != "" {
		if err := c.ready(); err != nil {
			return nil, err
		}
		return c.request(ctx, "GET", path, nil, false)
	}
	switch a.Operation {
	case "test":
		if err := c.ready(); err != nil {
			return nil, err
		}
		return c.Test(ctx)
	case "ai.run":
		return c.RunModel(ctx, a.Text)
	case "vectorize.query":
		return c.QueryMemory(ctx, a.Text)
	case "d1.query":
		return c.ExecuteSQL(ctx, a.SQL, a.Params)
	case "kv.get":
		return c.ReadKV(ctx, a.Key)
	case "r2.list":
		return c.ListObjects(ctx, a.Cursor)
	case "r2.get":
		return c.ReadObject(ctx, a.Key)
	default:
		return nil, errors.New("unknown Cloudflare operation")
	}
}
func (c Config) ready() error {
	if !c.Enabled {
		return errors.New("Cloudflare is disabled")
	}
	return c.Validate()
}
func (c Config) RunModel(ctx context.Context, text string) (json.RawMessage, error) {
	if err := c.ready(); err != nil {
		return nil, err
	}

	if !validModel(c.Model) || text == "" {
		return nil, errors.New("configure a Workers AI model and enter a prompt")
	}
	return c.request(ctx, "POST", "/ai/run/"+c.Model, map[string]any{"messages": []map[string]string{{"role": "user", "content": text}}}, false)
}
func (c Config) QueryMemory(ctx context.Context, text string) (json.RawMessage, error) {
	if err := c.ready(); err != nil {
		return nil, err
	}

	if c.Index == "" || !validModel(c.EmbeddingModel) || text == "" {
		return nil, errors.New("configure an index and embedding model, then enter search text")
	}
	data, err := c.request(ctx, "POST", "/ai/run/"+c.EmbeddingModel, map[string]any{"text": []string{text}}, false)
	if err != nil {
		return nil, err
	}
	var embed struct {
		Data [][]float64 `json:"data"`
	}
	if json.Unmarshal(data, &embed) != nil || len(embed.Data) != 1 {
		return nil, errors.New("embedding model returned an unexpected shape")
	}
	return c.request(ctx, "POST", "/vectorize/v2/indexes/"+url.PathEscape(c.Index)+"/query", map[string]any{"vector": embed.Data[0], "topK": 5, "returnMetadata": "all"}, false)
}
func (c Config) ExecuteSQL(ctx context.Context, sql string, params []any) (json.RawMessage, error) {
	if err := c.ready(); err != nil {
		return nil, err
	}

	if c.DatabaseID == "" || strings.TrimSpace(sql) == "" {
		return nil, errors.New("configure a D1 database and enter SQL")
	}
	return c.request(ctx, "POST", "/d1/database/"+c.DatabaseID+"/query", map[string]any{"sql": sql, "params": params}, false)
}
func (c Config) ReadKV(ctx context.Context, key string) (json.RawMessage, error) {
	if err := c.ready(); err != nil {
		return nil, err
	}

	if c.NamespaceID == "" || key == "" || key == "." || key == ".." {
		return nil, errors.New("configure a KV namespace and enter a key")
	}
	return c.request(ctx, "GET", "/storage/kv/namespaces/"+c.NamespaceID+"/values/"+url.PathEscape(key), nil, true)
}
func validModel(model string) bool {
	return strings.HasPrefix(model, "@") && !strings.Contains(model, "..") && !strings.ContainsAny(model, "?#%\\ \r\n")
}

type ObjectPreview struct {
	Preview     string  `json:"preview"`
	ContentType *string `json:"contentType"`
	Range       *string `json:"range"`
}
type ObjectPage struct {
	Objects []types.Object `json:"objects"`
	Cursor  *string        `json:"cursor"`
}

func (c Config) objectClient() (*s3.Client, error) {
	if err := c.ready(); err != nil {
		return nil, err
	}
	if c.Bucket == "" || c.AccessKey == "" || c.SecretKey == "" {
		return nil, errors.New("R2 object access requires bucket, S3 Access Key ID and Secret Access Key")
	}
	return s3.New(s3.Options{HTTPClient: &http.Client{Transport: c.Transport, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, Region: "auto", BaseEndpoint: aws.String("https://" + c.AccountID + ".r2.cloudflarestorage.com"), Credentials: credentials.NewStaticCredentialsProvider(c.AccessKey, c.SecretKey, ""), UsePathStyle: true, RetryMaxAttempts: 1}), nil
}
func (c Config) ListObjects(ctx context.Context, cursor string) (ObjectPage, error) {
	cl, err := c.objectClient()
	if err != nil {
		return ObjectPage{}, err
	}
	input := &s3.ListObjectsV2Input{Bucket: &c.Bucket, MaxKeys: aws.Int32(100)}
	if cursor != "" {
		input.ContinuationToken = &cursor
	}
	result, err := cl.ListObjectsV2(ctx, input)
	if err != nil {
		return ObjectPage{}, errors.New("R2 list failed; check S3 credentials and bucket")
	}
	return ObjectPage{Objects: result.Contents, Cursor: result.NextContinuationToken}, nil
}
func (c Config) ReadObject(ctx context.Context, key string) (ObjectPreview, error) {
	if key == "" {
		return ObjectPreview{}, errors.New("enter an object key")
	}
	cl, err := c.objectClient()
	if err != nil {
		return ObjectPreview{}, err
	}
	result, err := cl.GetObject(ctx, &s3.GetObjectInput{Bucket: &c.Bucket, Key: &key, Range: aws.String("bytes=0-1048575")})
	if err != nil {
		return ObjectPreview{}, errors.New("R2 read failed; check object key and credentials")
	}
	defer result.Body.Close()
	data, err := io.ReadAll(io.LimitReader(result.Body, 1<<20))
	if err != nil {
		return ObjectPreview{}, errors.New("R2 read interrupted")
	}
	return ObjectPreview{Preview: string(data), ContentType: result.ContentType, Range: result.ContentRange}, nil
}
