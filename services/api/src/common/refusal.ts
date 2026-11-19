/** A business refusal raised while executing a payment; the instruction becomes FAILED with this code and nothing is written. */
export class PaymentRefusal extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
