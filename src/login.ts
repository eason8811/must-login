/** Credentials used by the example adapter. Adapt this to your real protocol. */
export interface LoginCredentials {
  username: string;
  password: string;
}

/**
 * The consumer supplies the actual authentication implementation.
 * This skeleton intentionally does not send HTTP requests or store tokens.
 */
export type LoginHandler<TResult> = (
  credentials: Readonly<LoginCredentials>,
) => TResult | Promise<TResult>;

export interface LoginClient<TResult> {
  login(credentials: Readonly<LoginCredentials>): Promise<TResult>;
}

/** Create a small login client with a pluggable authentication adapter. */
export function createLoginClient<TResult>(
  handler: LoginHandler<TResult>,
): LoginClient<TResult> {
  return {
    async login(credentials) {
      return handler(credentials);
    },
  };
}
