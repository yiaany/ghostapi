import { resendPack } from "./packs/resendPack.js";
import type { ProviderAdapter } from "./types.js";

export const resendAdapter: ProviderAdapter = resendPack;
