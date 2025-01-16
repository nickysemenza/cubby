.PHONY: wasm
wasm: recipebridge/pkg/recipebridge_bg.wasm

recipebridge/pkg/recipebridge_bg.wasm: recipebridge/src/* recipebridge/Cargo.*
	wasm-pack build --out-dir pkg recipebridge
