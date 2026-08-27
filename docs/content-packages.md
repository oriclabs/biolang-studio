# Lesson package contract

BioLang Studio does not ship courses. It discovers checksummed manifest metadata from the separate BioLang Registry, while the actual lesson remains in its owning repository. Users may also add a custom manifest URL. **Remove** deletes the local entry and its cached declared data.

Registry discovery alone downloads only the small registry index. Selecting **Install** fetches the lesson manifest, verifies its exact SHA-256 before parsing, and loads the notebook. It still does not download declared datasets; each dataset requires an explicit **Prepare** action. If the registry is offline, Studio may display its last validated cached index and labels it as an offline cache.

## Minimal manifest

```json
{
  "schema": 1,
  "id": "my-course-first-lab",
  "title": "My first lab",
  "summary": "A one-sentence description.",
  "entry": "lesson.bln",
  "runtime": "browser",
  "estimatedMemoryMb": 20,
  "source": {
    "title": "Source or inspiration",
    "url": "https://example.org/source",
    "note": "What was reused or independently created"
  },
  "datasets": [],
  "tags": ["beginner"]
}
```

`entry` resolves relative to the manifest URL. The content host must permit browser CORS requests for the manifest, notebook, and datasets.

## Declaring data

Each dataset entry requires `id`, `title`, the short `path` used by BioLang, an HTTPS `url`, exact `bytes`, SHA-256, media type, source, citation, and rights note. Studio never fetches it merely because the lesson was installed. The user sees its size and source, selects **Prepare**, and the checksum must match before it reaches the kernel.

```json
{
  "id": "measurements",
  "title": "Published measurements",
  "path": "measurements.csv",
  "url": "https://data.example.org/measurements-v1.csv",
  "bytes": 12345,
  "sha256": "64 lowercase hexadecimal characters",
  "mediaType": "text/csv",
  "source": "Repository and version",
  "citation": "Citation or DOI",
  "rights": "Dataset licence or access note"
}
```

## Ownership

The content repository owns lesson correctness, numerical reference tests, data provenance, licence notices, and versioning. Studio tests only the generic manifest, download, checksum, cache, kernel, rendering, and removal behaviours.

GitHub raw files work for public prototypes. A release asset or versioned static host is preferable for stable courses: moving a branch must not silently change a validated lesson.
