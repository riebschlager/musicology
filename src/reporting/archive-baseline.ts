export const ARCHIVE_BASELINE = {
  version: "track-evidence-2026-07-21",
  spotifyAccepted: 61_031,
  // Coverage counts accepted music-track evidence; the 10 additional raw-audio duplicates belong
  // to excluded podcast/audiobook rows and remain documented in PROJECT_APPROACH.md.
  spotifyDuplicated: 391,
  spotifyExcluded: 83,
  spotifyRejected: 0,
  lastfmAccepted: 62_266,
  lastfmDuplicated: 0,
  lastfmRejected: 0,
} as const;
