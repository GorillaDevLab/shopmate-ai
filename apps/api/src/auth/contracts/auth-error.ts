export const AuthErrorCode = {
  InvalidCredentials: "INVALID_CREDENTIALS",
  Unauthenticated: "UNAUTHENTICATED",
  Forbidden: "FORBIDDEN",
} as const;

export type AuthErrorCode = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];

export interface AuthError {
  readonly code: AuthErrorCode;
  readonly message: string;
}

const authErrorMessages: Readonly<Record<AuthErrorCode, string>> = {
  INVALID_CREDENTIALS: "邮箱或密码错误",
  UNAUTHENTICATED: "请先登录",
  FORBIDDEN: "无权执行此操作",
};

export function createAuthError(code: AuthErrorCode): Readonly<AuthError> {
  return Object.freeze({ code, message: authErrorMessages[code] });
}
