import json, os, sys, urllib.request, sqlite3
key = sqlite3.connect(f"file:{os.path.expanduser('~/.maurice/maurice.db')}?mode=ro", uri=True).execute("select fal_api_key from households").fetchone()[0]
def call(model, body, out):
    req = urllib.request.Request(f"https://fal.run/{model}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Authorization": f"Key {key}"})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=300))
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode()[:600]); return False
    img = (r.get("images") or [r.get("image")])[0]
    urllib.request.urlretrieve(img["url"], out); print("ok", out, img.get("width"), img.get("height")); return True
STYLE = ("Flat vector editorial illustration, simple rounded shapes, flat colour fills with no outlines and no gradients, "
         "friendly faceless characters with simplified features, generous empty space. Plain cream background (#faf8f5), no frame, no border. "
         "Strictly limited palette: cream, warm sand, terracotta, muted ochre, sage green, near-black ink (#1c1b1a), and one vivid accent, a deep royal blue (#003399). "
         "No text, no letters, no logos, no watermark.")
SCENE = ("A wide interior view of a small, calm Parisian neighbourhood café. In the centre, a wooden bar counter; behind it stands the owner, Maurice, "
         "a kindly man wearing a black bowler hat and a deep royal blue apron, the bowler hat being the single darkest shape in the picture and clearly recognisable. "
         "On the wall behind him, a chalkboard easel with a few chalk lines and small drawn rectangles like posters, and a shelf with coffee cups and a few books. "
         "On the left, a round café table where three friends talk together, one of them turned towards the bar with a raised hand as if calling the owner; coffee cups and an open notebook on the table. "
         "On the right, a person alone at a small round table reading a book, a cup and a closed notebook beside them; further right, two people sharing a table, one showing the other a page of a book. "
         "A large leafy plant, pendant lamps. Nobody drinks beer; it is a quiet daytime place for reading and conversation. ")
if __name__ == "__main__":
    model, n = sys.argv[1], sys.argv[2]
    body = {"prompt": SCENE + STYLE}
    if model.startswith("openai/"): body.update({"image_size": "landscape_16_9", "quality": "medium", "output_format": "png"})
    else: body.update({"image_size": {"width": 1536, "height": 832}, "num_images": 1})
    call(model, body, f"scene-{n}.png")
