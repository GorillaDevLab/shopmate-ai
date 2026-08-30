import { Transform } from "class-transformer";
import { IsEmail, IsString, MaxLength, MinLength } from "class-validator";

export class LoginInputDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
  @IsString({ message: "邮箱必须是字符串" })
  @IsEmail({}, { message: "请输入有效的邮箱地址" })
  @MaxLength(254, { message: "邮箱长度不能超过 254 个字符" })
  email!: string;

  @IsString({ message: "密码必须是字符串" })
  @MinLength(8, { message: "密码长度不能少于 8 个字符" })
  @MaxLength(128, { message: "密码长度不能超过 128 个字符" })
  password!: string;
}
