# Hiyori v2 — 追加画像リクエスト（最小セット：キャラ左手・掌正面）

> **状況（2026-09-29）：未納品。**
>
> - `reference/hand-L-open-master-v1.png` と `hand-L-fist-master-v1.png` は、不透明のマスター絵です。open は格子背景が画素に焼き込まれています。どちらもこの仕様の透明 PNG キットを満たしておらず、ランタイムでは使っていません。
> - 利用する場合は、元画像を変えずにシルエットメッシュ・UV・クリップを作る別形式で行います（README「Artwork status」）。
> - それまでの open palm / point / fist は、原画の指ピクセルによる袖手版です。握りこぶしは「sleeve fist」です。

目的：原画に存在しない「開いた掌・指差し・握りこぶし・分離した指」を、ひよりの原画と同じ見た目・尺度で作る。
ここにある画像は **private な再構成アセット**であり、公式デザインの変更・新規公式キャラではない。
デザイン（肌色、線、袖、手の大きさ・比率）は原画に合わせる。原画に無いものを「公式」と表記しない。

リグ側（`rig/hiyori-v2.rig.json`）は、この仕様どおりのファイルが `assets/hand-L/` に置かれた時点で読み込む。
それまでは原画の指ストリップ（ArtMesh79 の4本の指先 + 親指 ArtMesh78）で動作する。
`tools/check-assets.mjs` が、サイズ・透明背景・ピボット周辺の不透明度を機械チェックする。

---

## 0. 共通ルール

| 項目 | 値 |
| --- | --- |
| 対象 | **キャラの左手のみ**（画面右側、モデル座標 x>0 の腕。Cubism の `L` と同じ）。右手は後で **左右反転**して作る。掌正面なので反転しても解剖学的に正しい。 |
| 向き | **掌がこちら（視聴者）を向く**。基準姿勢は、腕を下ろし指先が **真下 (+y)** を向く状態。親指は **画面右 (+x)**（体の外側）。 |
| 尺度 | 原画は「テクスチャ 1px = モデルキャンバス 1px（2976px/unit）」。**納品は 2倍 (2x)**。下の数値は、特記がなければ 2x のファイル座標。 |
| 形式 | PNG、RGBA 8bit、**完全透明背景**（四隅と余白は alpha=0）。ストレートアルファ。影・床・背景・文字・枠線・ウォーターマークなし。 |
| 画風 | ひよりの原画に合わせる：アニメ調のセル塗り＋柔らかいグラデーション。主線は暗い茶色 `#2d2820`〜`#3f392d`、**2x で太さ 3〜4px**、先端は細く。 |
| 肌色 | ベース `#fae1c9`、影 `#e9d2bb` / `#d9c3ac`、指先と関節にごく淡いピンク（`#f6cfc0` 程度）。ハイライトは弱く。 |
| 爪 | 掌側からは基本見えない。握った指（P1）は爪側が見えるので、小さく淡い爪 `#f7e6dc`、細い線。 |
| 袖 | **手の画像に袖・カーディガンを描かない**。手首は原画の袖口（ArtMesh77）の下に潜る。 |
| 重なり用の余白 | 各パーツは、接続部に **オーバーラップ・タブ**（下記）を持つ。タブは同じ肌色で自然に塗り、主線は引かない。 |

### 手のローカル座標（1x、原画尺度）

リグはこの座標で組み立てる。2x ファイルでは値を2倍にする。

- 原点 **W = 手首中心**（袖口の縁が来る位置）。+y は指先方向、+x は親指側。
- 掌：手首の幅 88、指の付け根（ナックル）の幅 120、W からナックル線までの長さ 105。
- 指の付け根（MCP）の位置と幅（原画 ArtMesh79 の実測に合わせた比率）：

| 指 | MCP (x, y) | 指の幅 | 基節長 L1 | 中節+末節 L2 | 全長 |
| --- | --- | --- | --- | --- | --- |
| index 人差し指 | (+43, 105) | 32 | 52 | 48 | 100 |
| middle 中指 | (+13, 100) | 33 | 57 | 53 | 110 |
| ring 薬指 | (−16, 104) | 29 | 53 | 49 | 102 |
| pinky 小指 | (−42, 112) | 26 | 42 | 38 | 80 |
| thumb 親指 | CMC (+38, 28) | 30 | 50 | 45 | 95 |

- 親指の軸：+y から +x 側へ 35° 開いた方向。

---

## 優先度 P0 — 開いた掌・指差し・手振り・分離指（11ファイル）

これが揃えば、次が実描画で動く。
- open palm / big wave / pointing：指を折らない人差し指 + 他の指を基節で短縮
- 5本の指の独立カール（0〜0.6程度）
- spread（指の開き）

### P0-1 `assets/hand-L/palm.png`

| 項目 | 値 |
| --- | --- |
| キャンバス | **320 × 320** |
| ピボット W（手首中心） | **(160, 72)** |
| ナックル線 | y = 72 + 210 = **282** |
| 描く範囲 | 手首の上に 72px の「袖の中に隠れる」タブ（y=0〜72。台形のまま上辺は切れていてよい）→ 掌 → ナックル線の先 24px までの付け根タブ（指の下に潜る） |
| 含む | 掌、母指球（+x 側のふくらみ）、手相の線は2〜3本だけ淡く |
| 含まない | 指、親指の基節から先 |

### P0-2 指セグメント（8ファイル）`assets/hand-L/finger-{index|middle|ring|pinky}-{1|2}.png`

`-1` は基節、`-2` は中節+末節（先端まで）。どれもまっすぐ下向き（+y）に描く。

| 項目 | 値 |
| --- | --- |
| キャンバス幅 | **96** |
| ピボット | **(48, 24)**。関節の中心。ここを軸に回転する。 |
| 上端タブ | y=0〜24 は丸い「関節キャップ」。親パーツの下に潜る側。 |
| 高さ | `-1`：24 + 2×L1 + 24（下端の子関節の先に、24px のタブ） |
| 高さ | `-2`：24 + 2×L2 + 8（指先の余白） |
| 子関節 | `-1` の子関節は **(48, 24+2×L1)**。`-2` はここに接続する。 |

具体的なサイズ（幅 × 高さ）：

| 指 | `-1` | `-2` |
| --- | --- | --- |
| index | 96 × 152 | 96 × 128 |
| middle | 96 × 162 | 96 × 138 |
| ring | 96 × 154 | 96 × 130 |
| pinky | 96 × 132 | 96 × 108 |

指の幅（2x）：index 64、middle 66、ring 58、pinky 52。先端は丸く、`-2` の先端に淡いピンク。
掌側から見た指なので、関節のしわを短い線で1本ずつ（`-1` の下端近く、`-2` の中ほど）描く。

### P0-3 親指（2ファイル）`assets/hand-L/thumb-1.png`, `thumb-2.png`

指セグメントと同じ規約（幅 96、ピボット (48,24)、真下向きに描く）。
- `thumb-1`：96 × 148（L1=50）
- `thumb-2`：96 × 122（L2=45）

リグ側で 35° 回して CMC (+38,28) に付ける。親指は掌側から見るので、母指球へ自然につながる丸みを持たせる。

### P0 の重なり順（奥 → 手前）

1. 指 `-1`（4本）、`thumb-1`
2. **palm**：指の付け根タブを覆い、掌の縁線が指の付け根のしわになる
3. 指 `-2`（`-1` の下端タブを覆う）、`thumb-2`
4. （リグ）原画の前腕袖 ArtMesh77：palm の手首タブを覆う

---

## 優先度 P1 — 握りこぶし（5ファイル）

掌正面で指を曲げると、指は視聴者側へ折れて掌に重なり、**爪側（指の背）**が見える。
これは回転や短縮では作れないので、「折れた指」を別絵にする。
カールが 0.55〜0.8 の間で、P0 の指（短縮）からこの絵へクロスフェードする。

### `assets/hand-L/finger-{index|middle|ring|pinky}-curled.png`

| 項目 | 値 |
| --- | --- |
| 形 | 指の背（中節+末節、爪が小さく見える）が MCP から掌の中心へ向かって **上向き (−y)** に折れて寝ている |
| キャンバス | 96 × 160 |
| ピボット | **(48, 136)**（MCP、下端寄り） |
| 見える長さ（2x） | index 120、middle 128、ring 120、pinky 96（ピボットから上へ） |
| 重なり | 上端は掌の中央に乗る |

### `assets/hand-L/thumb-curled.png`

| 項目 | 値 |
| --- | --- |
| 形 | 親指が掌を横切って −x 方向へ折れ、人差し指と中指の curled の上に乗る |
| キャンバス | 160 × 96 |
| ピボット | **(136, 48)**（CMC 側、右端寄り） |

### P1 の重なり順

palm → curled 4本（pinky → index の順に手前）→ thumb-curled。

---

## 優先度 P2（後回し。最小セット完成後）

- `hand-L-back`：手の甲。手を返す動きに使う。
- 袖口の内側（前腕が視聴者を向く短縮時の穴の見え方）。
- 腕を上げたときに見える、胴体の脇・アームホール。
- 右手は P0/P1 を左右反転して作る。反転で問題が出た場合（光源の向きなど）だけ個別に作る。

---

## imagegen 用プロンプト

imagegen で1パーツずつ正確な寸法を出すのは難しいため、次の手順を推奨する。
1. **マスター画像**を 4x（1x の4倍）で生成する。
2. Codex が切り出して寸法を合わせる。
3. 重なりタブは、隠れる部分を塗り足す（インペイント）。

参照画像として、private のまま原画の次の部分を添付すると色と線が合いやすい。
- `texture_01.png` の手の領域：ArtMesh79 の指 (1317,946)-(1455,1074)、ArtMesh77 の袖口付近
- `preview.jpg`

### M1（P0 のマスター）— open palm

```
Anime cel-shaded illustration of a single LEFT hand of a young girl, palm facing the viewer,
fingers straight and slightly spread, fingertips pointing straight DOWN, thumb on the right
side angled 35 degrees outward, wrist at the top edge cut straight (no sleeve, no arm).
Match this exact art style: soft pastel anime character art, warm peach skin #fae1c9 with
soft shading #e9d2bb, very pale pink on fingertips and knuckle creases, thin dark brown
outline #2d2820 that tapers at the ends, minimal highlights, small slender feminine hand.
Proportions: palm width at knuckles 1.36x wrist width; middle finger length 1.05x palm length.
Isolated on a fully transparent background, no shadow, no text, no border, centered,
orthographic front view, high resolution 1280x1280.
```

### M2（P0 の切り出し補助）— 指を1本ずつ

M1 から切り出すとき、指の付け根が掌に隠れて足りない場合に使う。

```
Same hand style as reference. A single isolated straight {index|middle|ring|pinky|thumb}
finger of the girl's LEFT hand seen from the palm side, pointing straight down, with a
rounded joint cap at the top, finger crease lines, pale pink fingertip, thin tapered dark
brown outline #2d2820, skin #fae1c9, shading #e9d2bb. Transparent background, no shadow,
no text, orthographic, 512x1024, finger centered.
```

### M3（P1 のマスター）— fist from the palm side

```
Same girl's LEFT hand, palm facing the viewer, making a soft loose fist: the four fingers
are folded toward the viewer and lie over the palm so the backs of the middle and tip
segments and small pale nails are visible, knuckles along the bottom edge; the thumb is
folded across in front of the index and middle fingers. Wrist at the top edge cut
straight, no sleeve. Anime cel shading matching the reference: skin #fae1c9, shading
#e9d2bb, thin tapered dark brown outline #2d2820, pale pink on knuckles. Transparent
background, no shadow, no text, orthographic front view, 1280x1280.
```

### M4（任意）— pointing

M3 の人差し指だけ伸ばした版。P0 と P1 の組み合わせで作れるので、確認用。

```
Same LEFT hand, palm facing the viewer, index finger straight pointing down, the middle,
ring and pinky folded over the palm (nail side visible), thumb folded over the middle
finger. Same style, transparent background, no shadow, 1280x1280.
```

### 否定プロンプト（共通）

```
sleeve, cardigan, arm, forearm, glove, ring, jewelry, nail polish, extra fingers, six
fingers, fused fingers, realistic skin texture, photographic, 3D render, thick outline,
black outline, heavy shadow, drop shadow, background, frame, text, watermark
```

---

## 受け入れ条件（`tools/check-assets.mjs` が機械チェック。見た目は Codex が確認）

1. ファイル名と寸法がこの表と完全に一致する。
2. 四隅 8×8px の alpha がすべて 0。
3. 各ピボットから半径 6px の範囲が不透明（alpha ≥ 200）。関節の中心に絵がある。
4. 主線の色相が茶系：主線サンプルの平均が R>G>B で、明度が 30% 以下。
5. 指の幅：
   - 中節の中央で測った不透明幅が、表の幅 ±15%。
   - 掌のナックル線での幅が 240 ±24。
6. 並べたとき（リグの rest の組み立て）に、指と掌の境目で alpha が途切れない。`tools/render-poses.mjs --hand-kit` の出力で確認する。
