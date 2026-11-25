/**
 * Probe provider for the P0 auto-deny measurement: registers one model
 * behind a local openai-completions endpoint (the fake-model server started
 * by the harness on 127.0.0.1). Scripted behavior: request 1 and 3 reply
 * with a bash tool call, request 2 and 4 with a plain completion, so pi
 * runs its real bash tool twice per probe without any network LLM.
 */
export default function (pi: {
  registerProvider: (name: string, config: Record<string, unknown>) => void;
}) {
  pi.registerProvider("probe", {
    name: "Probe",
    baseUrl: "http://127.0.0.1:18771/v1",
    apiKey: "probe-local",
    api: "openai-completions",
    models: [
      {
        type: "chat",
        id: "fake-chat",
        name: "Fake Chat",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 4096,
      },
    ],
  });
}
