use safetensors::{Dtype, SafeTensors};
use std::fs;
use std::path::Path;
use tokenizers::{Tokenizer, TruncationParams};

pub(crate) const EMBEDDING_DIMENSION: usize = 128;
const MAX_EMBEDDING_TOKENS: usize = 512;

pub(crate) struct SemanticModel {
    tokenizer: Tokenizer,
    embeddings: Vec<f32>,
    vocabulary_size: usize,
    unknown_token_id: Option<u32>,
}

impl SemanticModel {
    pub(crate) fn load(model_path: &Path, tokenizer_path: &Path) -> Result<Self, String> {
        let mut tokenizer =
            Tokenizer::from_file(tokenizer_path).map_err(|error| error.to_string())?;
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: MAX_EMBEDDING_TOKENS,
                ..Default::default()
            }))
            .map_err(|error| error.to_string())?;
        let unknown_token_id = tokenizer.token_to_id("[UNK]");

        let bytes = fs::read(model_path).map_err(|error| error.to_string())?;
        let tensors = SafeTensors::deserialize(&bytes).map_err(|error| error.to_string())?;
        let embeddings = tensors
            .tensor("embeddings")
            .map_err(|error| error.to_string())?;
        if embeddings.dtype() != Dtype::F32
            || embeddings.shape().len() != 2
            || embeddings.shape()[1] != EMBEDDING_DIMENSION
        {
            return Err("The bundled semantic model has an unsupported tensor layout".to_owned());
        }
        let vocabulary_size = embeddings.shape()[0];
        let data = embeddings.data();
        let values = data
            .as_chunks::<4>()
            .0
            .iter()
            .map(|bytes| f32::from_le_bytes(*bytes))
            .collect::<Vec<_>>();
        if values.len() != vocabulary_size * EMBEDDING_DIMENSION {
            return Err("The bundled semantic model is incomplete".to_owned());
        }
        Ok(Self {
            tokenizer,
            embeddings: values,
            vocabulary_size,
            unknown_token_id,
        })
    }

    pub(crate) fn encode(&self, text: &str) -> Result<[f32; EMBEDDING_DIMENSION], String> {
        let encoding = self
            .tokenizer
            .encode_fast(text, false)
            .map_err(|error| error.to_string())?;
        let ids = encoding
            .get_ids()
            .iter()
            .copied()
            .filter(|id| Some(*id) != self.unknown_token_id)
            .filter(|id| (*id as usize) < self.vocabulary_size)
            .collect::<Vec<_>>();
        let mut output = [0.0; EMBEDDING_DIMENSION];
        if ids.is_empty() {
            return Ok(output);
        }
        for id in &ids {
            let start = *id as usize * EMBEDDING_DIMENSION;
            for (value, embedding) in output
                .iter_mut()
                .zip(&self.embeddings[start..start + EMBEDDING_DIMENSION])
            {
                *value += embedding;
            }
        }
        let scale = 1.0 / ids.len() as f32;
        for value in &mut output {
            *value *= scale;
        }
        let norm = output.iter().map(|value| value * value).sum::<f32>().sqrt();
        if norm > 0.0 {
            for value in &mut output {
                *value /= norm;
            }
        }
        Ok(output)
    }
}

pub(crate) fn quantize(vector: &[f32; EMBEDDING_DIMENSION]) -> Vec<u8> {
    vector
        .iter()
        .map(|value| ((value.clamp(-1.0, 1.0) * 127.0).round() as i8) as u8)
        .collect()
}

pub(crate) fn cosine_quantized(query: &[f32; EMBEDDING_DIMENSION], vector: &[u8]) -> Option<f32> {
    if vector.len() != EMBEDDING_DIMENSION {
        return None;
    }
    let mut dot = 0.0;
    let mut norm = 0.0;
    for (query_value, stored) in query.iter().zip(vector) {
        let value = *stored as i8 as f32 / 127.0;
        dot += query_value * value;
        norm += value * value;
    }
    (norm > 0.0).then(|| dot / norm.sqrt())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundled_model() -> SemanticModel {
        let resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/semantic");
        SemanticModel::load(
            &resources.join("potion-base-4M.safetensors"),
            &resources.join("potion-base-4M-tokenizer.json"),
        )
        .unwrap()
    }

    fn cosine(left: &[f32; EMBEDDING_DIMENSION], right: &[f32; EMBEDDING_DIMENSION]) -> f32 {
        left.iter()
            .zip(right)
            .map(|(left, right)| left * right)
            .sum()
    }

    #[test]
    fn quantized_cosine_preserves_nearby_vectors() {
        let mut vector = [0.0; EMBEDDING_DIMENSION];
        vector[0] = 0.8;
        vector[1] = 0.6;
        let stored = quantize(&vector);
        assert!(cosine_quantized(&vector, &stored).unwrap() > 0.99);
    }

    #[test]
    fn bundled_model_connects_related_build_concepts() {
        let model = bundled_model();
        let query = model
            .encode("release workflow and deployment process")
            .unwrap();
        let related = model
            .encode("updated the Docker build pipeline and APK packaging step")
            .unwrap();
        let unrelated = model
            .encode("changed the sidebar color and rounded corner padding")
            .unwrap();
        assert!(cosine(&query, &related) > cosine(&query, &unrelated));
    }
}
