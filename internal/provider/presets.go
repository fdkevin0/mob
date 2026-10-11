package provider

// Preset is a vendor Mob knows how to reach: adding one needs only a key.
// Catalog names its models.dev entry, which describes its models and lists
// them when the vendor serves no model list of its own.
type Preset struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Chat      string `json:"chat,omitempty"`
	Anthropic string `json:"anthropic,omitempty"`
	Catalog   string `json:"catalog,omitempty"`
	KeysURL   string `json:"keysUrl,omitempty"`
	// NoKey marks local servers, where a key is optional.
	NoKey bool `json:"noKey,omitempty"`
	// PublicKey is sent when the user saved none (OpenCode Zen's free tier).
	PublicKey string `json:"-"`
	// AppKey is sent when the user saved none, to a local gateway that
	// takes any key and tells apps apart by it (magpie).
	AppKey string `json:"-"`
	// Default is the model a new installation starts on.
	Default string `json:"-"`
	quirk   quirk
}

// presets are ordered as `mob provider add --help` lists them.
var presets = []Preset{
	{ID: "opencode", Name: "OpenCode Zen", Chat: "https://opencode.ai/zen/v1", Catalog: "opencode", KeysURL: "https://opencode.ai/auth",
		PublicKey: "public", Default: "mimo-v2.6-flash-free", quirk: openCode},
	{ID: "openai", Name: "OpenAI", Chat: "https://api.openai.com/v1", Catalog: "openai", KeysURL: "https://platform.openai.com/api-keys"},
	{ID: "anthropic", Name: "Anthropic", Anthropic: "https://api.anthropic.com", Catalog: "anthropic", KeysURL: "https://console.anthropic.com/settings/keys"},
	{ID: "deepseek", Name: "DeepSeek", Chat: "https://api.deepseek.com/v1", Anthropic: "https://api.deepseek.com/anthropic", Catalog: "deepseek", KeysURL: "https://platform.deepseek.com/api_keys"},
	{ID: "google", Name: "Google Gemini", Chat: "https://generativelanguage.googleapis.com/v1beta/openai", Catalog: "google", KeysURL: "https://aistudio.google.com/apikey"},
	{ID: "openrouter", Name: "OpenRouter", Chat: "https://openrouter.ai/api/v1", Catalog: "openrouter", KeysURL: "https://openrouter.ai/keys"},
	{ID: "moonshot", Name: "Kimi", Chat: "https://api.moonshot.ai/v1", Anthropic: "https://api.moonshot.ai/anthropic", Catalog: "moonshotai", KeysURL: "https://platform.moonshot.ai/console/api-keys"},
	{ID: "zhipu", Name: "Zhipu GLM", Chat: "https://open.bigmodel.cn/api/paas/v4", Catalog: "zhipuai", KeysURL: "https://open.bigmodel.cn/usercenter/apikeys"},
	{ID: "ollama", Name: "Ollama", Chat: "http://localhost:11434/v1", NoKey: true},
	{ID: "lmstudio", Name: "LM Studio", Chat: "http://localhost:1234/v1", NoKey: true},
	// The address is magpie's default; `mob provider add magpie` finds the
	// port magpie is set to.
	{ID: "magpie", Name: "Magpie", Chat: "http://127.0.0.1:3425/v1", Anthropic: "http://127.0.0.1:3425", NoKey: true, AppKey: magpieKey},
}

func Presets() []Preset { return append([]Preset(nil), presets...) }

func FindPreset(id string) *Preset {
	for i := range presets {
		if presets[i].ID == id {
			return &presets[i]
		}
	}
	return nil
}
