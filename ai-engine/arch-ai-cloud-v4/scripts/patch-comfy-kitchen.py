"""Compatibility patch for comfy-kitchen 0.2.34 on pinned PyTorch 2.6.

PyTorch 2.6 accepts typing.List in custom-op schemas but not PEP-585 list.
The rewrite is intentionally version-gated and fails if no expected annotation
is found, preventing a future package layout from being silently modified.
"""

from __future__ import annotations

import importlib.metadata
from pathlib import Path


EXPECTED_PACKAGE_VERSION = "0.2.34"
EXPECTED_TORCH_VERSION = "2.6.0"
ANNOTATIONS = ("int", "bool", "float", "str")


def main() -> None:
    package_version = importlib.metadata.version("comfy-kitchen")
    torch_version = importlib.metadata.version("torch").split("+")[0]
    if package_version != EXPECTED_PACKAGE_VERSION or torch_version != EXPECTED_TORCH_VERSION:
        raise SystemExit("COMFY_KITCHEN_PATCH_VERSION_MISMATCH")

    distribution = importlib.metadata.distribution("comfy-kitchen")
    package_root = Path(distribution.locate_file("comfy_kitchen")).resolve()
    changed_files = 0
    changed_annotations = 0

    for source_path in package_root.rglob("*.py"):
        source = source_path.read_text(encoding="utf-8")
        patched = source
        replacements = 0
        for annotation in ANNOTATIONS:
            needle = f"list[{annotation}]"
            replacements += patched.count(needle)
            patched = patched.replace(needle, f"typing.List[{annotation}]")
        if replacements == 0:
            continue
        if "import typing\n" not in patched:
            future_import = "from __future__ import annotations\n"
            if future_import in patched:
                patched = patched.replace(
                    future_import, future_import + "\nimport typing\n", 1
                )
            else:
                patched = "import typing\n" + patched
        source_path.write_text(patched, encoding="utf-8", newline="\n")
        changed_files += 1
        changed_annotations += replacements

    if changed_files == 0 or changed_annotations == 0:
        raise SystemExit("COMFY_KITCHEN_PATCH_TARGETS_NOT_FOUND")

    init_path = package_root / "__init__.py"
    init_source = init_path.read_text(encoding="utf-8")
    triton_import = "from .backends import triton as _triton_backend  # noqa: F401"
    guarded_import = (
        "if torch.cuda.is_available():\n"
        "    from .backends import triton as _triton_backend  # noqa: F401"
    )
    if init_source.count(triton_import) != 1:
        raise SystemExit("COMFY_KITCHEN_TRITON_IMPORT_NOT_FOUND")
    init_path.write_text(
        init_source.replace(triton_import, guarded_import, 1),
        encoding="utf-8",
        newline="\n",
    )

    print(
        "COMFY_KITCHEN_COMPAT_OK "
        f"files={changed_files} annotations={changed_annotations} cpu_triton_guard=1"
    )


if __name__ == "__main__":
    main()
