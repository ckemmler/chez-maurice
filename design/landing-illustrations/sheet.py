import base64, sys
from gen import call
ref = "data:image/png;base64," + base64.b64encode(open("cafe-scene.png","rb").read()).decode()
prompt = ("Using exactly the same illustration style, colours and level of detail as this picture (flat vector shapes, no outlines, same palette on the same plain cream background), "
          "draw a sheet of eight separate isolated objects arranged in a tidy grid of four columns and two rows, each object centred in its own cell with wide empty margins around it, nothing touching or overlapping, no shadows on the ground, no text, no letters. "
          "Top row, left to right: 1) a closed notebook with an elastic band and a ribbon bookmark, royal blue cover; 2) a black bowler hat, seen from the side; 3) a small round café table on a single central leg with one coffee cup on it; 4) a chalkboard on a wooden easel with a few chalk lines and two small coloured posters pinned on it. "
          "Bottom row, left to right: 5) an old-fashioned door key; 6) a paper café bill on a small round tray with two coins; 7) a framed film poster showing a simple landscape with a sun, no text; 8) an open book with a pencil lying across it.")
call("openai/gpt-image-2/edit", {"image_urls":[ref], "prompt": prompt, "quality":"medium", "output_format":"png", "image_size":"landscape_16_9"}, sys.argv[1])
