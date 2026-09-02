#!/usr/bin/env python3
"""Assemble lab screenshots into a captioned submission PDF.

Usage:
    create-pdf.py --manifest <manifest.json> --output <submission.pdf>

manifest.json is an ordered JSON array of {"screenshotPath": "...", "command": "..."}.
One page per screenshot; each page is captioned with the step's command.
"""
import argparse
import json
import os

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as pdfcanvas


def draw_page(c: "pdfcanvas.Canvas", page_width: float, page_height: float, idx: int, command: str, image_path: str) -> None:
    margin = 12 * mm
    content_w = page_width - 2 * margin
    caption_h = 18 * mm
    image_area_h = page_height - 2 * margin - caption_h

    # Compute scaled image size preserving aspect ratio.
    try:
        reader = ImageReader(image_path)
        img_w, img_h = reader.getSize()
    except Exception as exc:  # noqa: BLE001 - produce a readable page rather than crash
        # Cannot read the image; render a note instead of an image.
        c.setFont("Helvetica-Bold", 12)
        c.drawString(margin, page_height - margin - 20, f"Image unreadable: {os.path.basename(image_path)}")
        c.setFont("Helvetica", 10)
        c.drawString(margin + 4, page_height - margin - 40, str(exc))
        draw_caption(c, margin, page_height - margin - caption_h, idx, command)
        return

    scale = min(content_w / img_w, image_area_h / img_h, 1.0)
    draw_w = img_w * scale
    draw_h = img_h * scale
    x = (page_width - draw_w) / 2
    y = margin + caption_h + (image_area_h - draw_h) / 2
    c.drawImage(image_path, x, y, width=draw_w, height=draw_h, preserveAspectRatio=True, anchor="c")

    draw_caption(c, margin, margin, idx, command)


def draw_caption(c: "pdfcanvas.Canvas", left: float, y: float, idx: int, command: str) -> None:
    c.setFillColorRGB(0.0, 0.0, 0.0)
    c.setFont("Helvetica-Bold", 11)
    label = f"Step {idx}"
    c.drawString(left, y + 14, label)
    c.setFont("Courier", 9)
    c.setFillColorRGB(0.1, 0.1, 0.1)
    # Wrap command text across the page width.
    wrapped = wrap_command(command, int((11 * mm) / (9 * 0.5)))
    for i, line in enumerate(wrapped):
        c.drawString(left + 2, y + 14 - 13 - i * 11, line)


def wrap_command(command: str, width: int) -> list[str]:
    if len(command) <= width:
        return [command]
    parts = command.split(" ")
    lines: list[str] = []
    cur = ""
    for part in parts:
        if not cur:
            cur = part
        elif len(cur) + 1 + len(part) <= width:
            cur += " " + part
        else:
            lines.append(cur)
            cur = part
    if cur:
        lines.append(cur)
    return lines


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, help="path to manifest.json")
    parser.add_argument("--output", required=True, help="output PDF path")
    args = parser.parse_args()

    with open(args.manifest, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    page_w, page_h = A4
    c = pdfcanvas.Canvas(args.output, pagesize=A4)

    for idx, entry in enumerate(manifest, start=1):
        path = entry.get("screenshotPath")
        command = entry.get("command", "")
        if not path or not os.path.isfile(path):
            raise SystemExit(f"manifest entry {idx}: screenshotPath not found: {path}")
        draw_page(c, page_w, page_h, idx, command, path)
        c.showPage()

    c.save()
    print(f"Wrote {idx} page(s) to {args.output}", file=__import__("sys").stdout)


if __name__ == "__main__":
    main()