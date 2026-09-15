import {
  KodaXOpenAICompatProvider,
  KodaXAnthropicCompatProvider,
  registerModelProvider,
  type KodaXCustomProviderConfig,
  type KodaXProviderConfig,
} from "@kodax-ai/kodax/llm";

// Apply at the SDK client's transport boundary, including background review calls.
// No process-wide fetch patch: fixed providers and source connectors are unchanged.
const endpointFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return new Response(
      JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: "自定义 API 不接受重定向，请填写最终服务的 Base URL。",
        },
      }),
      {
        status: 400,
        headers: { "content-type": "application/json" },
      },
    );
  }
  return response;
};

function providerConfig(
  config: KodaXCustomProviderConfig,
): KodaXProviderConfig {
  return {
    apiKeyEnv: config.apiKeyEnv,
    baseUrl: config.baseUrl,
    model: config.model,
    supportsThinking: false,
    reasoningCapability: "none",
    userAgentMode: "compat",
  };
}
class CustomOpenAI extends KodaXOpenAICompatProvider {
  readonly name: string;
  protected readonly config: KodaXProviderConfig;
  constructor(config: KodaXCustomProviderConfig) {
    super();
    this.name = config.name;
    this.config = providerConfig(config);
  }
  protected async buildClient() {
    return (await super.buildClient()).withOptions({ fetch: endpointFetch });
  }
}
class CustomAnthropic extends KodaXAnthropicCompatProvider {
  readonly name: string;
  protected readonly config: KodaXProviderConfig;
  constructor(config: KodaXCustomProviderConfig) {
    super();
    this.name = config.name;
    this.config = providerConfig(config);
  }
  protected async buildClient() {
    return (await super.buildClient()).withOptions({ fetch: endpointFetch });
  }
}
export function registerEndpointProvider(config: KodaXCustomProviderConfig) {
  return registerModelProvider(config.name, () =>
    config.protocol === "openai"
      ? new CustomOpenAI(config)
      : new CustomAnthropic(config),
  );
}
