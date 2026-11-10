# Koudai-oh Animation

Koudai-oh の状態を 8bit 風ドット絵アニメーション（5fps）で表示する。
ブラウザで開けば動く。ビルドもサーバも不要。

- `dist/koudaioh.html` … 羽なし版。1 ファイルでどこに置いても動く（ロボットへのコピー、アプリのプレビューなど）
- `dist/koudaioh_wings.html` … 羽付き版・羽ばたき。椅子の上に浮いて羽ばたく
- `dist/koudaioh_glide.html` … 羽付き版・滑空。羽を広げたまま、足裏の噴射で浮く
- `web/index.html` … 開発用。同じフォルダの `.js` を読み込むので、`web/` フォルダごと開く（`?wings=1`、`?fly=glide`）

| 羽なし | 羽付き・羽ばたき | 羽付き・滑空 |
|---|---|---|
| ![demo](docs/preview/demo.gif) | ![wings demo](docs/preview/wings_demo.gif) | ![glide demo](docs/preview/glide_demo.gif) |

## 動かし方

```
dist/ の 1 ファイル版（koudaioh.html / koudaioh_wings.html / koudaioh_glide.html）をブラウザで開く（file:// のままでよい）
```

`KoudaiohAnim is not defined` と出る場合は、`web/index.html` を単体で開いていて隣の `.js` が読めていない。
`dist/` の 1 ファイル版を使うか、`web/` フォルダごと開く。

| キー | ボタン | 内容 |
|---|---|---|
| `1` | 平時 | ① アイドリング |
| `2` | CAN通信死 | ② 内部ハードウェアエラー |
| `3` | 自動運転 | ③ AUTO MODE |
| `4` / `Space` | 発射 | ④ 発射（単発。終わると元の状態に戻る） |
| `5` | 通信切断 | ⑤ スマホとの NO LINK |
| `6` | 登場 | 画面外から椅子に飛び乗る（右から / 左から）。羽付き版は飛んで来る |
| `7` | 退場 | 椅子から画面外へ飛び降りる（左へ / 右へ）。羽付き版は飛び去る |
| `H` | — | 操作パネルの表示切替 |
| `W` | 羽を生やす / 羽を消す | 変身。中心から光が広がって全体を包み、光が消えると羽が生えて（消えて）いる。羽のデータが入っているページ（`koudaioh_wings.html` / `koudaioh_glide.html`）だけ |
| — | 滑空にする / 羽ばたきにする | 羽付きの飛び方の切り替え（その場で変わる） |

### URL パラメータ

| 例 | 内容 |
|---|---|
| `?state=auto` | 初期状態（`idle` / `can_dead` / `auto` / `no_link`） |
| `?present=0` | 椅子に誰もいない状態から始める（登場で乗る） |
| `?ui=0` | 操作パネルを隠し、画面いっぱいに表示（ロボット搭載ディスプレイ用） |
| `?scale=4` | 拡大率。省略時は画面に収まる最大の整数倍 |
| `?fps=5` | コマ速度 |
| `?can=slump` | CAN 通信死を「ガクッと下がって静止」にする（既定は振動） |
| `?ws=ws://192.168.0.10:8080/` | コマンドを受け取る WebSocket の接続先（切れたら 2 秒ごとに再接続） |
| `?seed=1` | 乱数シード（スパークの出方を固定） |
| `?wings=1` / `?wings=0` | 羽付きで始める / 羽なしで始める（既定は `koudaioh_wings.html` と `koudaioh_glide.html` だけ羽付き）。変身すると URL もこれに書き換わる |
| `?fly=glide` / `?fly=flap` | 羽付き版の飛び方: 滑空 / 羽ばたき（既定は `koudaioh_glide.html` だけ滑空） |

### 外部から状態を切り替える（WebSocket）

`?ws=` を付けると、ページが WebSocket クライアントとして接続し、受け取ったコマンドで状態を切り替える。

受信（どちらの形式でもよい）:

```
auto
fire
enter left
{"cmd": "exit", "arg": "right"}
{"state": "no_link"}
wings on          羽を生やす (変身)。off で消す、toggle で反対に
fly glide         羽付きの飛び方。flap で羽ばたき
```

送信（状態が変わるたびにページから送る）:

```json
{"event": "state", "state": "auto"}
{"event": "action_start", "action": "fire"}
{"event": "action_end", "action": "fire"}
{"event": "wings", "wings": true}
{"event": "fly", "fly": "glide"}
```

### JavaScript から

```js
const anim = new KoudaiohAnim.Animator(KOUDAIOH_SPRITE, { state: 'idle', seed: 1 });
// 羽付き版: new KoudaiohAnim.Animator(KOUDAIOH_SPRITE, { wings: KOUDAIOH_WINGS, wingsOn: true, fly: 'flap' | 'glide' })
// 羽のデータを渡すと、羽なしの姿 (wingsOn: false) でもキャンバスは羽が収まる大きさ (320x256) になる
anim.setState('auto');   // 持続状態: idle / can_dead / auto / no_link
anim.fire();             // 単発。椅子に乗っていて、他の動作中でなければ true
anim.exit('left');       // 乗っているときだけ
anim.enter('right');     // 不在のときだけ
anim.command('enter', 'left');   // 文字列でも同じ
anim.setWings(true);             // 羽のデータがあるとき: 光に包まれて羽が生える (false で消える)
anim.setFly('glide');            // 羽付きの飛び方
const raster = anim.step();      // 1 コマ描いて進める。raster.data は 192x256（羽付き版は 320x256）の RGBA
```

`web/index.html` では `window.koudaioh.command('fire')` で同じことができる。

動作中（発射・登場・退場）に `setState` すると、動作が終わった後にその状態になる。
動作中の別の動作は無視される（`false` が返る）。

## モーション

5fps（1 コマ 200ms）。解像度は元の 8bit 絵のドット格子そのままの 192×256 で、表示時に整数倍で拡大する。
動きとエフェクトの寸法は 1 unit = 2px で書いてある（「1 ピクセル上げる」は 1 unit）。

| | 本体 | 目 | エフェクト | ループ |
|---|---|---|---|---|
| ① 平時 | 1 unit 上げ下げ | 少し暗く → パッと明るく | — | 5 コマ |
| ② CAN 通信死 | 毎コマ上下左右に 1 unit ランダム（`slump` なら 1 unit 沈んで静止） | 毎コマ点滅、赤 / 黄 / 紫にランダム変色、黒いノイズ線 | 黄・青のスパーク、行ずれグリッチ | ランダム |
| ③ 自動運転 | 2 コマ周期で上下 | 光のラインが左右に往復 | 額マークが青 / 緑に点滅、頭上に `AUTO`、頭から広がるレーダー波 | 10 コマ |
| ④ 発射 | 1 unit 沈む → 2 unit 跳ね上がる → 揺れ 2 コマ → 復帰 | 溜めで白く強く発光 | 胸からマズルフラッシュ、衝撃波リング、煙 | 5 コマ単発 |
| ⑤ 通信切断 | 10 コマに 1 回だけゆっくり上下 | 消灯（バイザーの黒） | 頭上に `?` とアンテナ × がふわふわ、画面全体を減光 | 10 コマ |
| 登場 | 画面下（床）から放物線で椅子に飛び乗る → 着地で 2 unit 沈む | 一度暗くしてからパッと点灯 | 残像、着地の土煙 | 9 コマ単発 |
| 退場 | 屈んで溜める → 放物線で画面下へ飛び降りる | 溜めで明るく | 残像、踏み切りの土煙 | 7 コマ単発 |

| | |
|---|---|
| ① 平時 ![](docs/preview/idle.gif) | ② CAN 通信死 ![](docs/preview/can_dead.gif) |
| ③ 自動運転 ![](docs/preview/auto.gif) | ④ 発射 ![](docs/preview/fire.gif) |
| ⑤ 通信切断 ![](docs/preview/no_link.gif) | 登場・退場 ![](docs/preview/enter_exit.gif) |

コマ割りは `docs/preview/*_sheet.png`（全コマを横に並べたもの）で確認できる。

### 羽付き版

足（座った姿勢）はそのままで、本体ごと椅子の上に 12 unit（24px）浮き、羽ばたきに合わせてぷかぷか上下する。
羽は `assets/source/koudaioh_wings_sheet.png` の 5 コマ（01 上げ → 05 下げ）。打ち下ろしで体が持ち上がり、打ち上げで少し沈む。
座面には浮いた高さに応じた影が落ちる。目・額マーク・エフェクト・HUD は羽なし版と同じ。

| | 羽ばたき（羽のコマ） | 浮き方 |
|---|---|---|
| ① 平時 | 01→05→01 の往復、8 コマ | 打ち下ろしで 1 unit 上がり、打ち上げで 1 unit 沈む |
| ② CAN 通信死 | 毎コマランダム（痙攣） | 浮いたまま振動。`slump` なら椅子に落ちて羽はだらりと下がる（05） |
| ③ 自動運転 | 01→03→05→03、4 コマ（速い） | 速く上下 |
| ④ 発射 | 溜めで上げ → 発射で広げ → 反動で打ち下ろす | 浮いた位置から反動 |
| ⑤ 通信切断 | 04〜05 で下げ気味のまま | 低く（5 unit）浮き、10 コマに 1 回だけ動く |
| 登場 | 速く羽ばたく | 画面右上（または左上）から斜めに降りてきて浮く位置で止まる |
| 退場 | 溜めて強く打ち下ろす | 沈んでから上昇し、斜め上へ飛び去る |

| | |
|---|---|
| ① 平時 ![](docs/preview/wings_idle.gif) | ② CAN 通信死 ![](docs/preview/wings_can_dead.gif) |
| ③ 自動運転 ![](docs/preview/wings_auto.gif) | ④ 発射 ![](docs/preview/wings_fire.gif) |
| ⑤ 通信切断 ![](docs/preview/wings_no_link.gif) | 登場・退場 ![](docs/preview/wings_enter_exit.gif) |

### 羽付き版・滑空（羽ばたかずに飛ぶ）

羽を動かさずに「飛んでいる」と読ませるために、浮いている理由・羽の役割・浮遊感を別々の手がかりで見せている。

| 手がかり | 内容 | 何を伝えるか |
|---|---|---|
| 足裏の噴射 | 白い芯に青い縁の炎。毎コマ長さがちらつき、火の粉が散る | 何の力で浮いているか |
| 座面の波紋 | 噴射が当たった所から輪が広がる（椅子の上だけに描く） | 下へ押している力が実際に当たっている |
| 座面の影 | 浮いた高さに応じた大きさ | 椅子から離れている |
| 羽根筋の光 | 羽の白い筋に、付け根から先端へ水色の光が流れる（8bit のパレットサイクル） | 羽は飾りではなく働いている |
| ぷかぷか | 12 コマ（2.4 秒）の正弦波で ±2 unit。羽ばたき版より遅く大きい | 空中に支えなく浮いている |
| 羽のしなり | 体の上下に羽が 1 unit 遅れてついてくる | 羽が空気を受けている |

羽のコマは 02（少し上げた滑空の形）で固定。高さは 14 unit（28px）で、噴射が座面に届く距離にしている。

| | 噴射 | 羽・光 | 浮き方 |
|---|---|---|---|
| ① 平時 | 普通 | 02 固定、光はゆっくり | ゆっくり大きくぷかぷか |
| ② CAN 通信死 | 途切れ途切れ | 羽がガタつく（02〜04）、光なし | 浮いたまま振動。`slump` なら椅子に落ちて噴射も止まる |
| ③ 自動運転 | 強い | 02 固定、光が速い | 速く上下 |
| ④ 発射 | 反動を噴射で受け止める（強く噴く） | 02 固定 | 浮いた位置から反動 |
| ⑤ 通信切断 | 弱い | 04 で下げ気味、光なし | 低く浮き、10 コマに 1 回だけ動く |
| 登場 | 降りながら逆噴射でブレーキ | 03 で広げて降り、02 で止まる | 斜め上から降りてくる |
| 退場 | 強く噴いて上昇 | 03 | 斜め上へ飛び去る |

| | |
|---|---|
| ① 平時 ![](docs/preview/glide_idle.gif) | ② CAN 通信死 ![](docs/preview/glide_can_dead.gif) |
| ③ 自動運転 ![](docs/preview/glide_auto.gif) | ④ 発射 ![](docs/preview/glide_fire.gif) |
| ⑤ 通信切断 ![](docs/preview/glide_no_link.gif) | 登場・退場 ![](docs/preview/glide_enter_exit.gif) |

### 変身（羽を生やす / 消す）

`W` キー、羽ボタン、`wings on/off` コマンドで、羽なし ⇔ 羽付きをその場で切り替える。9 コマ（1.8 秒）。

| コマ | 光 | 姿 |
|---|---|---|
| 0〜2 | 胸の中心から光の円が広がる（白い芯、金の縁、水色の輪） | 元の姿 |
| 3〜4 | 画面全体を丸く覆う | 3 コマ目で入れ替わる（座る ⇔ 浮く の位置の変化も光の下で済ませる） |
| 5〜6 | 網目に間引かれて薄れる（半分 → 4 分の 1） | 新しい姿が透けて見えてくる |
| 7〜8 | きらめきだけ残る | 新しい姿 |

変身中は他の動作（発射・登場・退場）を受け付けない。椅子にいないときは演出なしで即座に切り替わる。

| 羽ばたき | 滑空 |
|---|---|
| ![](docs/preview/wings_transform.gif) | ![](docs/preview/glide_transform.gif) |

## ファイル

```
dist/koudaioh.html      1 ファイル版・羽なし（生成物。web/ の HTML と .js をまとめたもの）
dist/koudaioh_wings.html  1 ファイル版・羽付き・羽ばたき（生成物）
dist/koudaioh_glide.html  1 ファイル版・羽付き・滑空（生成物）
web/index.html          プレーヤー（操作パネル、キー操作、URL パラメータ、WebSocket）
web/koudaioh_anim.js    アニメーション本体。DOM 非依存（ブラウザでも Node でも同じ絵が出る）
web/player.js           一定 fps で回して canvas に整数倍表示する
web/sprite_data.js      スプライト（生成物。文字グリッドなので手でドット修正してもよい）
web/sprite_wings.js     羽 5 コマ（生成物）。本体と椅子は sprite_data.js を共有する
tools/build_sprite.py   元画像 → sprite_data.js
tools/build_wings.py    羽のシート → sprite_wings.js
tools/build_standalone.js  web/ → dist/ の 1 ファイル版 3 つ
tools/render_frames.js  ブラウザなしでフレームを書き出す
tools/export_gif.py     プレビュー GIF とコマ一覧を作る
assets/source/          元画像（KO-02 入り点灯版 / 旧点灯版 / 消灯版 / 羽のシート）
test/anim.test.js       状態遷移・左右対称・目の光漏れなしなどのテスト
```

## スプライトの作り方

```
npm run build                      # sprite_data.js → sprite_wings.js → dist/ の順に作り直す（Pillow, numpy が必要）
npm run preview                    # docs/preview/ を作り直す
npm test                           # web/ を変えたのに dist/ を作り直していないと失敗する
```

`build_sprite.py` の処理:

1. 元画像（`koudaioh_ko02.png`。元の 765×1024 の絵を 1.417 倍にして右肩に KO-02 を足したもの）を 765×1024 に戻し、4px 格子のドット絵なので 4×4 ブロックの中央値で 192×256 に取り込む（= 元絵の実解像度）
2. 外周とつながった黒を背景として除去。元画像の椅子は靴と重なっているので行・列・明るさで切り離し、椅子は楕円で描き直す（本体が離れても欠けないように）
3. 顔は消灯版（`koudaioh_eyes_off.jpg`）の画素を使う。目は「点灯版で赤く、消灯版で暗い（バイザーの中の）画素」を赤みで 4 段階に分けたもの。目の外の装甲への照り返しは含めない
4. 左右対称化: 向かって左半分を右へ鏡映する。軸は列 87（元絵は輪郭の軸が列 88、額マークなど内側の模様が列 87 とずれているので、顔の模様を優先）。その後キャンバス中央（列 95）へ寄せる
5. k-means で 10 階調に減色、1px アウトライン
6. 右肩に KO-02 を描く。対称化の後に描くので鏡映されない（左右対称の唯一の例外。範囲は `anchors.decal`）。
   元絵の文字は 1 文字 4×7px で、取り込むと潰れて読めないので、同じ角張った字形で打ち直して右上がりに傾けている

`build_wings.py` の処理:

1. シートの各コマのロボットを羽なし版の本体に位置合わせする（縮尺と位置。本体の画素だけを使ったマスク付き正規化相互相関を、numpy の FFT で縮尺を振って求める。シート 1.67px = 本体 1px）
2. 本体と同じ縮尺に取り込み、本体と椅子の外にある前景（輝度 8 以上。羽の黒い膜は 11〜20、背景は 0〜4）を羽とする。金を含まない破片（アンテナや輪郭のずれ）は捨てる
3. 向かって左の羽を右へ鏡映し、7 色に減色

`sprite_data.js` の文字の意味:

| 文字 | 意味 |
|---|---|
| `.` | 透明 |
| `0`〜`9` | グレー（暗 → 明） |
| `o` | アウトライン |
| `F` `E` `D` `d` | 目（芯 / 明赤 / 赤 / 暗赤）。状態ごとの色に置き換わる |
| `m` | 額のセンサーマーク。通常は `palette.m` の色、自動運転で青 / 緑に点滅 |
