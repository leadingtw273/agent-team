export type Result<Value, Failure> =
  Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false; error: Failure }>;

export function ok<Value>(value: Value): Result<Value, never> {
  return Object.freeze({ ok: true, value });
}

export function err<Failure>(error: Failure): Result<never, Failure> {
  return Object.freeze({ ok: false, error });
}

export function mapResult<Value, NextValue, Failure>(
  result: Result<Value, Failure>,
  transform: (value: Value) => NextValue,
): Result<NextValue, Failure> {
  return result.ok ? ok(transform(result.value)) : result;
}

export function flatMapResult<Value, NextValue, Failure, NextFailure>(
  result: Result<Value, Failure>,
  transform: (value: Value) => Result<NextValue, NextFailure>,
): Result<NextValue, Failure | NextFailure> {
  return result.ok ? transform(result.value) : result;
}
