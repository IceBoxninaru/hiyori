"""Fetch pinned public sample assets into ignored development paths, never Git."""
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from urllib.request import urlopen
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
FILES = {
    "hiyori": (
        "https://cubism.live2d.com/sample-data/bin/hiyori/hiyori_ja.zip",
        "FB618385EF225402AA9E0C9C8EC569261B973F3CD9BBBE96EF1C6F09F0BA11D0",
    ),
    "core": (
        "https://cubism.live2d.com/sdk-web/core/05/live2dcubismcore.min.js",
        "25AE938CB4FE282CE189B357BCC97E603D1E1F7EC78BF04150D401C23CDC792F",
    ),
}


def download(name):
    url, expected = FILES[name]
    with urlopen(url, timeout=60) as response:
        data = response.read(80 * 1024 * 1024 + 1)
    if len(data) > 80 * 1024 * 1024:
        raise RuntimeError(f"{name}: unexpected size")
    if sha256(data).hexdigest().upper() != expected:
        raise RuntimeError(f"{name}: source changed; hash mismatch")
    return data


def write(relative, data):
    target = ROOT / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


def main():
    # Fixed entry names only. Never extract paths supplied by an archive wholesale.
    with ZipFile(BytesIO(download("hiyori"))) as archive:
        for name in (
            "hiyori_pro_t11.moc3",
            "hiyori_pro_t11.2048/texture_00.png",
            "hiyori_pro_t11.2048/texture_01.png",
        ):
            write("public/live2d/hiyori/" + name,
                  archive.read("hiyori_pro/runtime/" + name))
        write("third-party/live2d/Hiyori-ReadMe.txt",
              archive.read("hiyori_pro/ReadMe.txt"))
    write("third-party/live2d/live2dcubismcore-5.2.min.js", download("core"))
    print("Pinned public assets prepared in ignored paths. No credentials used.")


if __name__ == "__main__":
    main()
