import { randomBytes } from "node:crypto";

/** 20-char URL-safe random password (120 bits). Shown once, never stored in plain text. */
export const generatePassword = () => randomBytes(15).toString("base64url");
