# Identity normalization

P2-01 defines `match-text-v1`, a pure matching-text rule used only by later identity and
reconciliation work. It never rewrites source display text: callers retain the exact
source-derived string alongside its nullable normalized matching value and this rule version.

`match-text-v1` applies Unicode NFC canonical composition, Unicode-default lowercasing,
whitespace collapsing and trimming, punctuation/symbol removal, and a deliberately narrow
canonicalization of whole-word `feat.`, `ft.`, and `featuring` markers to `feat`. It does not
remove or classify musical qualifiers. Terms such as `live`, `remix`, `radio edit`, `version`,
and movement names remain in the matching value.

A blank or whitespace-only display value normalizes to `null`, representing unknown matching text
rather than an empty identity. The rule is deterministic and has no locale or database dependency.

Normalization output is matching evidence, not display data and not authorization to merge
identities. Any change to the algorithm, including its Unicode form, punctuation treatment, or
featuring-marker scope, must introduce a new named normalization version and preserve prior stored
values under their original version. Existing values must not be silently rewritten.
