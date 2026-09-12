export const MODEL_POLICY_VERSION = 1 as const;
export type ProviderModelFamily = "gemini_omni_flash_1_1" | "veo" | "unknown";
export interface ModelPolicy { version:1; requiredFamily:Exclude<ProviderModelFamily,"unknown">; apiCode:null; allowFallback:false; executionBackend:"flow_ui"; selectionSource:"default"|"explicit"; }
export const DEFAULT_MODEL_POLICY:ModelPolicy=Object.freeze({version:1,requiredFamily:"gemini_omni_flash_1_1",apiCode:null,allowFallback:false,executionBackend:"flow_ui",selectionSource:"default"});
export function createModelPolicy(requestedModel?:string,selectionSource:"default"|"explicit"=requestedModel?"explicit":"default"):ModelPolicy{
  if(!requestedModel||/(?:gemini[\s_-]*)?omni(?:[\s_-]*flash)?(?:[\s_-]*1[._]1)?/i.test(requestedModel))return{...DEFAULT_MODEL_POLICY,selectionSource};
  if(/\bveo\b/i.test(requestedModel)||/^veo[-_]/i.test(requestedModel))return{version:1,requiredFamily:"veo",apiCode:null,allowFallback:false,executionBackend:"flow_ui",selectionSource:"explicit"};
  throw new Error("Unknown Flow UI model policy; choose Gemini Omni Flash 1.1 or an explicit visible Veo option");
}
