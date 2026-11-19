// The model "Send test message" uses when the user didn't pick one: a small,
// cheap-looking one if there is one (the mockup's rule), else the first.
export function pickTestModel(models: string[]): string | null {
  return models.find((m) => /haiku|mini|nano|flash|lite|small/i.test(m)) || models[0] || null;
}
