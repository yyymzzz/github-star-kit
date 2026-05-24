/**
 * @starkit/core/code — W5 deep-indexed code search pipeline.
 *
 * Three pure-function layers (chunker, fetcher, orchestrator) wired
 * callback-style so @starkit/core stays free of @starkit/ai +
 * @starkit/vector workspace deps. The popup adapts AIProvider.embed +
 * IndexedDBVectorStore + Octokit at the boundary, same pattern as the
 * embed / tag / digest orchestrators.
 */
export {
  chunkBySemantic,
  chunkBySlidingWindow,
  chunkSource,
  languageFromPath,
  normalizeLanguage,
  type ChunkKind,
  type ChunkOptions,
  type CodeChunk,
  type Language,
} from './chunk.js';
export {
  decodeBase64Content,
  DEFAULT_DENY_SEGMENTS,
  DEFAULT_EXTENSIONS,
  fetchRepoSource,
  filterTree,
  rankAndCap,
  type FetchRepoSourceOptions,
  type SourceFile,
} from './fetch.js';
export {
  indexRepoCode,
  type IndexRepoCodeOptions,
  type IndexRepoCodeResult,
} from './orchestrator.js';
