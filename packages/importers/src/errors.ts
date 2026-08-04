export class UnsupportedInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnsupportedInputError";
  }
}
