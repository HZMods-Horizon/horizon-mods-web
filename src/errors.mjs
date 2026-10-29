export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isUnique(err) {
  return err?.code === "23505" || /duplicate key|unique constraint/i.test(String(err?.message || ""));
}

export function zodError(err) {
  const message = err.issues?.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  }).join("; ");
  return new HttpError(400, "invalid", message || "Неверные поля");
}
