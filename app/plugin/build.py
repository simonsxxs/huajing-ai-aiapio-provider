"""Build the same self-contained AIAPIO plug-in ZIP for both desktop hosts."""

import argparse
import hashlib
import json
from math import gcd
from pathlib import Path
import re
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


SOURCE = Path(__file__).resolve().parent
APP = SOURCE.parent
VERSION = "0.1.0"
PARAMETERS = {"aspect_ratio", "size", "resolution", "duration", "mode", "count", "images", "videos", "audios", "url"}
FIELD_KEYS = ("default", "enum", "required", "max_items", "min_items", "max_items_by_mode", "min_items_by_mode")


def read_json(path):
    """Read an official snapshot or a checked-in JSON input."""
    return json.loads(path.read_text(encoding="utf-8"))


def snapshot(source):
    """Extract only metadata used for the plug-in from the public logical-model catalog."""
    catalog = read_json(source)
    models = []
    for model in catalog["models"]:
        if model["type"] not in {"image", "video"}:
            continue
        source_fields = model["param_schema"]
        fields = {name: {key: field[key] for key in FIELD_KEYS if key in field}
                  for name, field in source_fields.items() if name in PARAMETERS}
        defaults = {name: field["default"] for name, field in source_fields.items()
                    if name not in PARAMETERS and field.get("required") and "default" in field}
        unresolved = [name for name, field in source_fields.items()
                      if name not in PARAMETERS and field.get("required") and name not in defaults]
        entry = {"id": model.get("public_id") or model["id"], "name": model["display_name"],
                 "kind": model["type"], "fields": fields}
        if defaults:
            entry["defaults"] = defaults
        if unresolved or model.get("deprecated") or not model.get("available"):
            entry["blocked"] = unresolved or ["退役" if model.get("deprecated") else "目录标记不可用"]
        if "url" in fields:
            entry["source_url"] = model["type"]
        audio_description = source_fields.get("audios", {}).get("description", "")
        if fields.get("audios") and any(phrase in audio_description for phrase in
                                        ("不能单独用", "不能单独使用", "必须与图片或视频", "需配 ≥1 图或视频")):
            entry["audio_requires_visual"] = True
        if model.get("max_prompt_chars"):
            entry["max_prompt_chars"] = model["max_prompt_chars"]
        if model.get("max_prompt_bytes"):
            entry["max_prompt_bytes"] = model["max_prompt_bytes"]
        models.append(entry)
    ids = [model["id"] for model in models]
    if not models or len(ids) != len(set(ids)):
        raise ValueError("官方模型目录为空或存在重复公共 ID")
    return {"source": "https://aiapio.com/v1/logical-models", "generated_at": catalog["generated_at"], "models": models}


def unique(values):
    """Deduplicate manifest options while preserving their display order."""
    return list(dict.fromkeys(values))


def pixel_ratio(size):
    """Return the reduced aspect ratio of an explicit pixel size."""
    width, height = (int(part) for part in size.split("x"))
    divisor = gcd(width, height)
    return f"{width // divisor}:{height // divisor}"


def manifest_model(model):
    """Translate model properties supported by the official Huajing manifest."""
    fields = model["fields"]
    entry = {key: model[key] for key in ("id", "name", "kind")}
    sizes = fields.get("size", {}).get("enum", [])
    ratios = fields.get("aspect_ratio", {}).get("enum", [])
    resolutions = fields.get("resolution", {}).get("enum", [])
    if not ratios:
        ratios = [value for value in sizes if ":" in value or value == "auto"]
        ratios += [pixel_ratio(value) for value in sizes if re.fullmatch(r"\d+x\d+", value)]
    if not resolutions:
        resolutions = [value for value in sizes if re.fullmatch(r"[\d.]+[kK]", value)]
    durations = fields.get("duration", {}).get("enum", [])
    references = [kind for kind in ("image", "audio", "video")
                  if f"{kind}s" in fields or model.get("source_url") == kind]
    if ratios:
        entry["ratios"] = unique(ratios)
    if resolutions:
        entry["resolutions"] = unique(value.lower() for value in resolutions)
    if durations:
        entry["durations"] = sorted({int(value) for value in durations if str(value).isdigit() and int(value) > 0})
    if references:
        entry["referenceInputs"] = references
    return entry


def build(catalog_path, output):
    """Create a deterministic ZIP with the manifest, self-contained entry, and usage guide."""
    catalog = read_json(catalog_path)
    ordered = [model for model in catalog["models"] if not model.get("blocked")]
    priority = read_json(SOURCE / "price-priority.json")["order"]
    ordered.sort(key=lambda model: (model["kind"], priority.get(model["id"], 1_000_000)))
    manifest = {
        "id": "aiapio-provider", "name": "AIAPIO · 沙鸥 AI", "version": VERSION,
        "description": "使用自己的 AIAPIO API Key，在画布生成和编辑图片、视频。",
        "kind": "mixed", "runtime": "js", "entry": "handler.js", "billing": "byo",
        "models": [manifest_model(model) for model in ordered],
        "config": [
            {"key": "api_key", "label": "AIAPIO API Key", "type": "password", "default": "", "required": True},
            {"key": "video_image_mode", "label": "视频参考图用法", "type": "select", "default": "auto", "options": [
                {"value": "auto", "label": "自动"}, {"value": "reference", "label": "多素材参考"},
                {"value": "first-frame", "label": "仅首帧"}, {"value": "first-last", "label": "首尾帧"}]},
            {"key": "poll_timeout", "label": "查询超时（秒）", "type": "number", "default": 1800},
        ],
    }
    model_data = {model["id"]: model for model in ordered}
    handler = "const MODELS = " + json.dumps(model_data, ensure_ascii=False, separators=(",", ":")) + ";\n\n"
    handler += (SOURCE / "handler.js").read_text(encoding="utf-8")
    contents = {"manifest.json": json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                "handler.js": handler, "README.md": (APP / "docs" / "安装与使用.md").read_text(encoding="utf-8")}
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".tmp", delete=False) as staging:
        work = Path(staging.name)
    try:
        with ZipFile(work, "w", compression=ZIP_DEFLATED, compresslevel=9) as bundle:
            for filename, content in contents.items():
                member = ZipInfo(f"aiapio-provider/{filename}", (2026, 11, 25, 0, 0, 0))
                member.compress_type = ZIP_DEFLATED
                member.external_attr = 0o100644 << 16
                bundle.writestr(member, content.encode("utf-8"))
        with ZipFile(work) as bundle:
            if bundle.testzip():
                raise ValueError("插件 ZIP 完整性检查失败")
        work.replace(output)
    finally:
        work.unlink(missing_ok=True)
    print(f"{output}\n模型数 {len(ordered)}\nSHA-256 {hashlib.sha256(output.read_bytes()).hexdigest()}")


def main():
    """Optionally refresh a checked-in catalog snapshot and build the plug-in."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog-source", type=Path, help="本地 AIAPIO 官方模型目录 JSON")
    parser.add_argument("--output", type=Path, default=APP / "dist" / f"aiapio-provider-{VERSION}.zip")
    arguments = parser.parse_args()
    catalog = SOURCE / "catalog.json"
    if arguments.catalog_source:
        data = snapshot(arguments.catalog_source)
        lines = [json.dumps(model, ensure_ascii=False, separators=(",", ":")) for model in data.pop("models")]
        header = json.dumps(data, ensure_ascii=False, indent=2).removesuffix("\n}")
        catalog.write_text(header + ',\n  "models": [\n    ' + ',\n    '.join(lines) + '\n  ]\n}\n', encoding="utf-8")
    build(catalog, arguments.output)


if __name__ == "__main__":
    main()
