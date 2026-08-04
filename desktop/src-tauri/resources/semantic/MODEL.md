# Bundled semantic search model

Agent Vis bundles `minishlab/potion-base-4M` at commit
`9b3cff412d30be9ae8603fe10224c224f3401869`.

- Model: `potion-base-4M.safetensors`
- Model SHA-256: `8a7140edd17ffab30ddcff1135eda127df57abfae856203dbd7b3d061295c31a`
- Tokenizer: `potion-base-4M-tokenizer.json`
- Tokenizer SHA-256: `e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50`
- Source: `https://huggingface.co/minishlab/potion-base-4M`
- License: MIT; see `LICENSE-model2vec.txt`

The model produces 128-dimensional static sentence embeddings. Agent Vis runs
tokenization and normalized mean pooling locally; it performs no model download
and sends no session text to a remote service.
