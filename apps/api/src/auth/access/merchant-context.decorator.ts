import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

import type { AuthContext } from "../contracts/index.js";

export interface AuthenticatedRequest {
  auth?: AuthContext;
}

export const MerchantContext = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().auth,
);
