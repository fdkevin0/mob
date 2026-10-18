package wechatilink

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// Client executes HTTP requests against the official WeChat iLink API.
type Client struct {
	Config     Config
	HTTPClient *http.Client
}

// NewClient returns a Client for WeChat iLink.
func NewClient(cfg Config, transport http.RoundTripper) *Client {
	return &Client{
		Config: cfg,
		HTTPClient: &http.Client{
			Transport: transport,
			Timeout:   45 * time.Second,
		},
	}
}

func (c *Client) setHeaders(req *http.Request) {
	req.Header.Set("AuthorizationType", "ilink_bot_token")
	if c.Config.BotToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.Config.BotToken)
	}
	req.Header.Set("X-WECHAT-UIN", "10001")
	req.Header.Set("iLink-App-Id", "bot")
	req.Header.Set("iLink-App-ClientVersion", "2.4.8")
	req.Header.Set("Content-Type", "application/json")
}

// QRCodeResult holds QR Code information for WeChat scanning.
type QRCodeResult struct {
	QRCode           string `json:"qrcode"`
	QRCodeImgContent string `json:"qrcode_img_content"`
}

// GetQRCode requests a login QR Code from the WeChat iLink API.
func (c *Client) GetQRCode(ctx context.Context) (*QRCodeResult, error) {
	reqURL := c.Config.EndpointURL() + "/ilink/bot/get_bot_qrcode?bot_type=3"
	payload := map[string]any{"local_token_list": []string{}}
	data, _ := json.Marshal(payload)

	req, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	c.setHeaders(req)

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("iLink QRCode request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("iLink QRCode status %d: %s", resp.StatusCode, string(body))
	}

	var res QRCodeResult
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, err
	}
	return &res, nil
}

// QRCodeStatusResult contains the confirmed scan status and Bot Token.
type QRCodeStatusResult struct {
	Status      string `json:"status"` // "wait", "scaned", "confirmed", "expired"
	BotToken    string `json:"bot_token"`
	ILinkBotID  string `json:"ilink_bot_id"`
	BaseURL     string `json:"baseurl"`
	ILinkUserID string `json:"ilink_user_id"`
}

// GetQRCodeStatus checks the authorization status of the QR Code.
func (c *Client) GetQRCodeStatus(ctx context.Context, qrcode string) (*QRCodeStatusResult, error) {
	reqURL := fmt.Sprintf("%s/ilink/bot/get_qrcode_status?qrcode=%s", c.Config.EndpointURL(), url.QueryEscape(qrcode))
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return nil, err
	}
	c.setHeaders(req)

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var res QRCodeStatusResult
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, err
	}
	return &res, nil
}

// InboundMessage represents a received WeChat message node.
type InboundMessage struct {
	MsgID        string     `json:"msg_id"`
	FromUserID   string     `json:"from_user_id"`
	ToUserID     string     `json:"to_user_id"`
	MessageType  int        `json:"message_type"`
	ContextToken string     `json:"context_token"`
	ItemList     []ItemNode `json:"item_list"`
}

// ItemNode holds item content (text, image, audio, etc.).
type ItemNode struct {
	Type     int       `json:"type"` // 1: text
	TextItem *TextItem `json:"text_item,omitempty"`
}

// TextItem carries text content.
type TextItem struct {
	Text string `json:"text"`
}

// UpdatesResult represents the response from long-polling getupdates.
type UpdatesResult struct {
	Ret                  int              `json:"ret"`
	Msgs                 []InboundMessage `json:"msgs"`
	GetUpdatesBuf        string           `json:"get_updates_buf"`
	LongpollingTimeoutMs int              `json:"longpolling_timeout_ms"`
}

// GetUpdates polls WeChat iLink for new messages.
func (c *Client) GetUpdates(ctx context.Context, cursor string) (*UpdatesResult, error) {
	reqURL := c.Config.EndpointURL() + "/ilink/bot/getupdates"
	payload := map[string]any{
		"get_updates_buf": cursor,
		"base_info": map[string]string{
			"channel_version": "2.4.8",
			"bot_agent":       "Mob",
		},
	}
	data, _ := json.Marshal(payload)

	req, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	c.setHeaders(req)

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("iLink getupdates error %d: %s", resp.StatusCode, string(body))
	}

	var res UpdatesResult
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, err
	}
	if res.Ret != 0 {
		return nil, fmt.Errorf("iLink getupdates failed: ret %d", res.Ret)
	}
	return &res, nil
}

// SendMessage delivers a text message back to the WeChat user.
func (c *Client) SendMessage(ctx context.Context, toUserID, contextToken, text string) error {
	reqURL := c.Config.EndpointURL() + "/ilink/bot/sendmessage"

	payload := map[string]any{
		"msg": map[string]any{
			"from_user_id":  c.Config.BotID,
			"to_user_id":    toUserID,
			"client_id":     fmt.Sprintf("mob-%d", time.Now().UnixNano()),
			"message_type":  2,
			"message_state": 2,
			"context_token": contextToken,
			"item_list": []map[string]any{
				{
					"type": 1,
					"text_item": map[string]string{
						"text": text,
					},
				},
			},
		},
		"base_info": map[string]string{
			"channel_version": "2.4.8",
			"bot_agent":       "Mob",
		},
	}

	data, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewReader(data))
	if err != nil {
		return err
	}
	c.setHeaders(req)

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("iLink sendmessage error %d: %s", resp.StatusCode, string(body))
	}
	var result struct {
		Ret int `json:"ret"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return err
	}
	if result.Ret != 0 {
		return fmt.Errorf("iLink sendmessage failed: ret %d", result.Ret)
	}
	return nil
}

// SendTyping notifies the user that the bot is generating a response.
func (c *Client) SendTyping(ctx context.Context, toUserID, contextToken string) error {
	reqURL := c.Config.EndpointURL() + "/ilink/bot/sendtyping"
	payload := map[string]any{
		"to_user_id":    toUserID,
		"context_token": contextToken,
	}
	data, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewReader(data))
	if err != nil {
		return err
	}
	c.setHeaders(req)

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}
