# Arcade artwork

## Final in-game fruit sprites

The user requested more detailed actual game art after the first iteration. The final watermelon game uses nine original juicy, glossy characters generated through the same authorized image API: grape, cherry, mandarin, lemon, kiwi, peach, persimmon, honeydew and watermelon. Exact prompt: [melon-fruit-sprites-prompt.txt](melon-fruit-sprites-prompt.txt).

The gateway returned a 1254×1254 sprite sheet for the requested 1536×1536 canvas. The imagegen skill's `remove_chroma_key.py` removed the uniform cyan background using auto corner sampling, soft matte thresholds 40/100 and one-pixel edge contraction. Nine cells were normalized to transparent 512×512 WebP sprites. The final files and fruit-core alignment metadata live at `web/public/assets/games/watermelon/fruits/`; both the actual soft-body renderer and the site's game artwork use these assets. A 16-sector texture mesh follows the physical perimeter while retaining stems and leaves.

`melon-fruit-sprites-sheet.png`, `melon-fruit-sprites-alpha.png` and `melon-fruit-sprites-preview.jpg` are local source/inspection artifacts, not runtime dependencies. The credentials used for generation are not stored in any source, prompt or asset.

## Earlier cover explorations

Two original cover illustrations generated with `gpt-image-2` through the user-authorized compatible image API on 2026-09-10. The imagegen skill's bundled CLI was attempted first; this gateway returned HTTP 403 to SDK requests, including the read-only model endpoint. The gateway accepted a standard HTTPS REST image-generation request with `response_format: b64_json`. Credentials were process-local and are not stored in these artifacts.

- `wind-sprout-cover.png` / `.webp`: mint seed creature with leaf ears and cream wings, floating between moss-covered garden islands.
- `watermelon-cover.png` / `.webp`: clay watermelon and smaller fruit in a glass bowl.
- `soft-watermelon-cover.png` / `.webp`: the final semi-fluid variant requested by the user. Translucent fruit spread and deform against one another. The website uses this version.

The PNGs are source outputs. WebP copies are resized to a maximum width of 1440px at quality 85 for the website. No generated image is used by the standalone game runtime.

## Flight prompt

Create an original premium 3D clay game-cover illustration for a tiny garden arcade. A single adorable pale mint-green round seed creature with two small pointed leaf ears, tiny cream-colored wings, two little deep evergreen eyes and a subtle warm blush, floating gently through a gap between moss-capped rounded limestone pillars suspended in air. Small distant floating garden islands and soft cream clouds give depth. Sophisticated soft-touch matte clay material, subtle fine grain, diffuse morning sunlight from top left, soft ambient occlusion, high-end independent game art direction. Muted sage and pistachio greens, warm ivory, a tiny buttery yellow sun; no saturated blue or purple. Landscape composition with the character at center-right, generous breathing room, clean silhouette, readable at small sizes. Charming and serene rather than busy. No typography, no letters, no logos, no watermark, no existing game characters, no pixel art, no interface, no collage.

## Watermelon prompt

Create an original premium 3D clay game-cover illustration for a tiny garden arcade, with the same sophisticated pale mint, warm ivory and soft diffuse morning-light art direction. A charming collection of round soft-touch clay fruits stacked in a shallow clear rounded glass bowl: one large striped forest-green watermelon with tiny dot eyes and a content smile, one warm yellow pear, a peach, a tangerine, a strawberry and a pair of cherries. Fruit forms are simple spheres or rounded organic forms, each with a tiny leaf and a subtle characterful expression, matte satin shading and delicate ambient occlusion. The watermelon is the dominant recognizable hero. A few little sparkles suggest a satisfying merge. Warm cream background, soft sage floor, a very subtle curved shadow; beautifully composed still life, editorial product photography quality. Landscape composition, fruit concentrated centrally, plenty of empty space near the edges, readable silhouette. No text, no typography, no logos, no watermark, no UI, no collage, no existing intellectual property.

Both requests used 1536x1024, high quality, one image each. The final prompts were sent without repository source or personal data.

## Final semi-fluid watermelon prompt

Create an original premium 3D game-cover illustration for a novel semi-fluid watermelon merge game. In a shallow clear glass vessel sits a large adorable translucent jade-green watermelon GEL BLOB, with dark green wavy watermelon stripes, two tiny glossy black eyes and a little content smile. It is visibly soft and squishy: its bottom spreads into a broad rounded puddle, and its sides gently bulge around smaller fruit blobs pressed into it. Around it are a soft peach-colored jelly blob, an amber citrus gel blob, a tiny raspberry-red cherry gel blob, each visibly flattened where it rests, with tiny happy faces. Beautiful viscous tension, subtle subsurface scattering, delicate inner bubbles, glossy soft highlights, a tiny stem leaf on the watermelon, gentle organic deformations. Make it immediately clear these are squeezable, shape-changing semi-fluid fruit, not solid spheres. Refined toy-like material with a little clay charm; high-end independent game art. Warm ivory background, pale sage floor, diffuse morning light, soft ambient shadows, muted forest green with restrained peach/amber accents. Landscape composition with clean central silhouette and breathing room at every edge. Playful, serene, tactile and exceptionally polished. No words, no typography, no letters, no logos, no watermark, no user interface, no collage, no existing game characters. 1536 by 1024 landscape.

Generated with the same model and parameters. The station now features the actual nine fruit sprites. These earlier covers remain local exploration artifacts; flight is retained as a standalone game outside the station catalogue.
