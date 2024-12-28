.PHONY: wasm
wasm: recipebridge/pkg/recipebridge_bg.wasm

recipebridge/pkg/recipebridge_bg.wasm: recipebridge/src/* recipebridge/Cargo.*
	wasm-pack build --target web --out-dir recipebridge/pkg recipebridge
