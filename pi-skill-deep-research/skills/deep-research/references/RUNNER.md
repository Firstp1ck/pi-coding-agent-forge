# Isolated scientific runner setup

Read this before running the scientific classifier. Python 3 is required. The runner reads pre-collected claims/evidence and updates its state file; it does not search for sources. The snippets below use Bash. On other shells, use the same Python initialization and pass the resulting paths as arguments.

## Initialize one investigation

Use an authorized writable location. This example creates a unique directory using the operating system's temporary-directory facility, then writes the required initial state there. Keep the printed path if you intend to resume: temporary files may be removed by the operating system. For durable research, use a unique directory in the authorized project record location instead.

```bash
DR_RUN_DIR="$(python3 - <<'PY'
import json
import tempfile
from pathlib import Path

run_dir = Path(tempfile.mkdtemp(prefix="deep-research-"))
state = {
    "last_run": None,
    "runs": [],
    "claim_canonicalization": {},
    "source_dedupe_fingerprints": [],
    "metadata": {
        "policy_version": "1.0.0",
        "schema_version": "1.0.0",
        "created_at": None,
        "updated_at": None,
    },
}
with (run_dir / "state.json").open("x", encoding="utf-8") as handle:
    json.dump(state, handle, indent=2)
    handle.write("\n")
print(run_dir)
PY
)"
```

Directory creation and state initialization run in one Python invocation. The path is printed only after both succeed; on failure, report the error and stop rather than using the current directory. Creating state uses exclusive mode and must not overwrite an existing investigation. For a resume, set `DR_RUN_DIR` to that investigation's existing directory and skip initialization. Allow only one runner to update a given state file at a time. Separate investigations use separate directories.

## Collect and run

Save the verified claim and evidence arrays described in `SKILL.md` as `claims.json` and `evidence.json` inside `DR_RUN_DIR`. Redact sensitive data and check source support before execution. A file containing example claims is not evidence that the research occurred.

Resolve `B` to this skill's actual installed directory. `{baseDir}` is the host's skill-directory placeholder; replace it with the discovered absolute directory if the host does not expand it. Every writable path below is task-owned; policy, schema, and runner files are read from the skill.

```bash
B="{baseDir}"
: "${DR_RUN_DIR:?Initialize or select an investigation directory before running}"
python3 "$B/scripts/run_deep_research.py" \
  --topic "Scientific claim under investigation" \
  --claims-file "$DR_RUN_DIR/claims.json" \
  --evidence-file "$DR_RUN_DIR/evidence.json" \
  --policy "$B/policy.json" \
  --schema "$B/output-schema.json" \
  --state "$DR_RUN_DIR/state.json" \
  --output-json "$DR_RUN_DIR/output.json" \
  --output-md "$DR_RUN_DIR/output.md"
```

Do not use a fixed shared temporary path or write into the installed skill folder. Avoid concurrent runs within the same investigation; the runner does not lock shared state. Follow the authorized retention and cleanup policy for task artifacts.

## Interpret the result

Exit codes are `0` success, `1` validation/policy error, `2` partial retrieval, and `3` no-evidence fallback. Inspect failures and source limitations even when a command completes. Output checks cover selected fields and do not implement full JSON Schema validation. A verdict is the policy's classification of the supplied evidence, not a probability of scientific truth.
