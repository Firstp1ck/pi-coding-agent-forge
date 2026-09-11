export function parseRecord(input) {
  if (typeof input !== "string") throw new TypeError("record must be text");
  const fields = input.split("|");
  if (fields.length < 2 || fields.length > 3) throw new TypeError("record field count is invalid");
  const [name, rawAmount, category = "general"] = fields.map((field) => field.trim());
  if (!name) throw new TypeError("record name is required");
  const amount = Number(rawAmount);
  if (!Number.isInteger(amount) || amount < 0) throw new TypeError("record amount is invalid");
  if (!category) throw new TypeError("record category is required");
  return { name, amount, category };
}
