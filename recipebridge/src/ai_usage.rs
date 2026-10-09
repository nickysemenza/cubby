//! AI-usage accounting for gateway calls (`ai-usage`): the Worker's gateway
//! forwarder records each call's provider and tokens. Pricing is TypeScript's
//! (`models.dev`), not the cookbook catalog's.

use serde::{Deserialize, Serialize};
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;

/// Token counts for one model call (mirrors `cookbook::Usage`).
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
#[tsify(into_wasm_abi)]
pub struct WUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub reasoning_tokens: u64,
}

impl From<cookbook::Usage> for WUsage {
    fn from(usage: cookbook::Usage) -> Self {
        Self {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens,
            cache_creation_input_tokens: usage.cache_creation_input_tokens,
            reasoning_tokens: usage.reasoning_tokens,
        }
    }
}

/// What a host records per gateway call: the provider and the token usage.
#[derive(Tsify, Serialize, Deserialize, Debug, Clone, PartialEq)]
#[tsify(into_wasm_abi)]
pub struct WGatewayCallUsage {
    pub provider: String,
    pub usage: WUsage,
}

/// Usage from a raw provider response body; `None` for a model the
/// catalog does not know or a body without usage.
#[wasm_bindgen]
pub fn gateway_call_usage(model: &str, body: &str) -> Option<WGatewayCallUsage> {
    let model = cookbook::models::model(model)?;
    let usage = cookbook::gateway::usage_from_response(model.route, body)?;
    Some(WGatewayCallUsage {
        provider: model.provider.as_str().to_string(),
        usage: usage.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_usage_from_a_provider_body() {
        let call = gateway_call_usage(
            "gemini-2.5-flash",
            r#"{"usage":{"prompt_tokens":10,"completion_tokens":3}}"#,
        )
        .unwrap();
        assert!(!call.provider.is_empty());
        assert_eq!((call.usage.input_tokens, call.usage.output_tokens), (10, 3));
        assert!(gateway_call_usage("no-such-model", "{}").is_none());
    }
}
