# **AI Cartoon Step by Step: Every Prompt**

Mr-miro - https://www.youtube.com/watch?v=zGVQt4xoZAM
https://www.youtube.com/@miromotions

These are all the prompts from the video "How to Make an AI Cartoon Step by Step (Skill Included)", in the same order as the video. Copy them, change the parts in \[BRACKETS\], and make them your own.

**Free skill:** [https\://drive.google.com/file/d/1MwNc-8kSBqnW0GD3r1js1ScsJRyO0tfa/view?usp=sharing](https://drive.google.com/file/d/1MwNc-8kSBqnW0GD3r1js1ScsJRyO0tfa/view?usp=sharing)    
**SHA-256 of the zip:** b1af56111e24cb9043f010dbbe360b6f3f0607554e1f3940ac4602b9b9bc949b 

---

## **Before you start**

You need:

* **Claude Code**, on Windows or Mac.  
* **A voice-over** (a .wav file) and its **script** (a .txt file).  
* **About 1–2 hours** for your first Short. It gets faster every time.

You don't need to install anything else by hand. Step 1 checks everything for you.

---

## **Step 1: Setup**

1. Make a new, empty folder, for example "My Cartoon".  
2. Inside it, put the skill zip (inkbeat-shorts.zip) and a folder called **vo** with your voice-over files:  
   * vo/voice.wav: your voice-over  
   * vo/script.txt: your script  
   * vo/timings.json: the time of every word (if you don't have it, see the prompt below)  
3. Open Claude Code in that folder, and only that folder.

**Prompt 1: install the skill**

```
Install the skill in inkbeat-shorts.zip for this project: unzip it into .claude/skills/ so you can use it.
```

**Prompt 2: check your tools**

```
Check that I have Node.js, ffmpeg, and Python with numpy. If anything is missing, install it (winget on Windows, Homebrew on Mac), then tell me.
```

**If you don't have word timings yet:**

```
Make word timings for my voice-over: the audio is vo/voice.wav and the script is vo/script.txt. Use a free local tool (for example Whisper with word timestamps), match every word to my script text, and write vo/timings.json in the format the inkbeat-shorts skill's plan_src.py expects. Show me the first 10 words with their times so I can check them.
```

Tip: after installing, close and reopen Claude Code in the folder so the skill shows up in /skills. Even if it doesn't show up yet, Claude can still follow it.

---

## **Step 2: Start from the template (don't skip this)**

**Prompt 3**

```
/inkbeat-shorts Start a new project in this folder from the skill's templates, install it, and render the demo stills (Demo, DemoHero, DemoCast) so I can see the starting look. Don't build anything else yet.
```

Look at the three pictures. This is your starting point: if something looks wrong here, it will look wrong in your video too.

**Not sure what you're looking at? Ask Claude:**

```
Analyze out/demo.jpg. What looks good, what looks cheap, and what would you change? Be specific: where in the picture, and what to do instead.
```

Read the answer, keep what you agree with, and send that back as your feedback.

---

## **Step 3: The plan (the most important step)**

**Prompt 4**

```
/inkbeat-shorts Now make a [20]-second vertical 3D cartoon Short about [YOUR TOPIC].
My voice-over is vo/voice.wav, its word timings are vo/timings.json and the script is vo/script.txt.
Plan it anchored to the words, with the light following the story and sound-off tags on the key objects.
Show me the plan, then a look-dev sheet, then build and render it with motion blur and run the QA.
Stop after each step and wait for me.
```

**How to give feedback (use this every time)**

For each note, say three things: **what's wrong, where it is, and what you want instead.**

```
Good plan: keep [WHAT YOU LIKE]. [NUMBER] changes before the look-dev:
1. [WHAT'S WRONG] in [WHERE: scene / second / word]. I want [WHAT INSTEAD].
2. ...
Update the plan and show it again.
```

**My real example from the video:**

```
Good plan: keep the pacing, the 2 tags, the SFX and the transitions. Six changes before the look-dev:
1. Historical light: the flood happened around noon in January. Replace the dusk acts (S02-S05) with a cold winter noon under a heavy overcast sky that darkens and turns amber-brown as the wave hits. Keep S06 cold and S07 golden.
2. Hook as a two-beat reveal: on "tsunami." a close-up of the worker's shocked face (3/4 head, low lens); on "Of molasses." pull out fast to reveal the tank and the wave. The key object still has to be on screen in the first 2 s.
3. "BOSTON 1919" must be painted on something in the world (a warehouse sign or the side of a streetcar), unlit, not a floating card.
4. Give us 2-3 hero shots with a low lens and the character filling ~40% of the frame (the worker in S03 before he runs, the boot pull in S06, the shopkeeper in S07). Right now everyone is small.
5. The wave (S03-S05) must read as thick syrup: dark brown, glossy highlights, a rolling front with a curled lip, drips, and clearly taller than the two-storey house.
6. S07: the sweet smell as small, faint, semi-transparent wisps that never cross the face.
Update the plan and show it again.
```

---

## **Step 4: Look-dev, then the final render**

**Prompt 5: look-dev (cheap test pictures before the expensive render)**

```
The plan is good. Now show me the look-dev: one test picture for every scene, in its light, plus the characters. Then wait.
```

Give notes on the look-dev the same way as on the plan, or ask Claude to analyze the pictures for you (Step 2). Repeat until it looks right.

**Prompt 6: the final render**

```
The look-dev is good. Build it and render the final at full resolution: add a light music bed under the voice, story SFX on the exact words, all-white captions, and master it to -14 LUFS. Then show me the QA results and tell me honestly what still looks weak.
```

About music: only use music you have a license for. If you don't give Claude a track, it can make a simple original one.

---

## **Step 5: Watch it and fix it (the loop)**

Watch the final. Then say exactly what's wrong and where, and ask Claude to change only that.

**Template**

```
[NUMBER] changes to the final render, only in [SCENE / SECONDS]. Change only that and what it touches; keep everything else the same.
1. [WHAT'S WRONG]. I want [WHAT INSTEAD, in detail].
2. ...
Check your own work before rendering. Re-render only what changed, run the QA again, and show me the new final plus a contact sheet of the part you changed.
```

**My real example from the video (the molasses wave):**

```
Two changes to the final render, both on the molasses wave (S03-S05). Change only the wave and what it touches; keep everything else the same.

1. The wave has no dynamics and doesn't read as a real liquid. Make it move like a thick, heavy fluid:
   - a rolling front with a curled lip that keeps turning over as it advances, a thicker body behind it, and the height changing over time (it surges, slumps, surges again), never a rigid shape sliding forward;
   - glossy dark-brown surface with moving highlight streaks and ripples flowing along it, drips and strands falling off the lip, slow heavy splashes that stretch and fall back (viscous, not water spray);
   - it pushes and carries things: crates, a barrel and a cart get lifted and dragged along;
   - every motion stays a pure function of time (deterministic).

2. It goes THROUGH the houses. Make it physically correct: buildings are solid, the liquid never passes through walls.
   - when it hits a house it piles up against the wall, climbs it, then spills OVER the roof and pours down the other side, and it flows AROUND the corners and through the street between buildings;
   - check every frame of S03-S05 for any part of the wave inside a building and fix it.

Make the action clearer to read: hold a framing long enough to see the wave hit the house and go over it (at least ~1 s, no fast whip during the impact), and keep the wave's silhouette readable against the sky.

Re-render only what changed, run the QA again (flicker, interpenetration check on a 2 fps contact sheet), and show me the new final plus a contact sheet of S03-S05.
```

When you're happy:

```
Keep this version.
```

---

## **Make it yours: teach the skill your style**

Claude has no taste of its own. Give it a target it can measure, and it can hit it.

1. **Pick one channel** whose cartoons you'd love to make. Just one.  
2. **Take about 10 screenshots** of your favorite moments from 5–6 of their videos. Keep them on your computer, in a folder like "ref". Never upload them anywhere and never put them in your videos.  
3. **Ask Claude to study them:**

```
Study the frames in the ref folder. Measure the brightness, the colors, the shadows, how big the characters are, where the faces sit, how thick the outlines are, and where the captions go. Write it as a style guide with numbers.
```

4. **Add your own eyes:** watch one of their Shorts and count how many times the camera moves in 10 seconds. Tell Claude:

```
In their Shorts the camera moves about [NUMBER] times every 10 seconds. Add that to the style guide.
```

5. **Save it into your skill.** Without this step, Claude forgets everything in the next chat:

```
Save everything you learned from this analysis into my skill: the style guide, the numbers and the rules. Use them every time from now on.
```

6. **Make one test scene and compare:**

```
Make one test scene in this style and put it side by side with 3 of my reference frames. Tell me honestly what's different, with numbers.
```

Then the same loop as before: what's wrong, where, what you want instead. Two or three rounds.

7. **When it finally looks right:**

```
Put everything you learned in this session into the skill, so next time you start from here.
```

**One rule:** learn the look, the light and the rhythm. Never copy their characters or their designs. Make your own.

---

## **Quick fixes**

**The render is dark or flickers:**

```
The render flickers or has dark frames. Run the skill's flicker check on it, find the cause, and fix it. Render one at a time through gpu_lock.py.
```

**It looks cheap and you don't know why:**

```
Compare this frame with the skill's demo stills and tell me the 3 biggest differences, with what to change for each.
```

**Claude says "it looks great":**

```
Don't tell me what's good. List what is still weak, biggest problem first.
```

---

## **Questions?**

Ask in the comments under the video. Or join the community, where I answer myself and you get every new skill before anyone else, for \$2 a month: [https\://www\.skool.com/mrmiro/about](https://www.skool.com/mrmiro/about) 

