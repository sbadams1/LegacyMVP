# Git Survival Sheet – LegacyMVP

A quick-reference guide for saving working versions, experimenting safely, and recovering when things break.

---

# 🚀 QUICK COMMANDS (TL;DR)

Save a working version:
git add . && git commit -m "Working: description" && git push

Create a checkpoint (tag snapshot):
git tag -a v0.X -m "Checkpoint"
git push origin v0.X

Create a feature branch:
git checkout -b feature-newthing

Undo the last commit safely:
git revert <commit_id> && git push

Hard reset main to a known-good version:
git checkout main
git reset --hard <tag>
git push --force-with-lease

---

# 1. Everyday workflow

Check what’s changed:
git status

Save your current working version:
git add .
git commit -m "Working: short description here"
git push

---

# 2. Creating checkpoints (tags) for known-good builds

Create a tag:
git tag -a v0.1-working-tts -m "Stable build: STT + Gemini + TTS + memory_raw"
git push origin v0.1-working-tts

List tags:
git tag

Check out a tag (view-only):
git checkout v0.1-working-tts

Return to main:
git checkout main

---

# 3. Safe experiments with branches

Create a feature branch:
git checkout -b feature-vision

Save progress on the branch:
git add .
git commit -m "Add initial Vision API function"
git push -u origin feature-vision

Merge branch into main:
git checkout main
git merge feature-vision
git push

Delete branch (local):
git branch -D feature-vision

Delete branch (remote):
git push origin --delete feature-vision

---

# 4. Undoing mistakes

Undo the last bad commit (safe):
git log --oneline --decorate --graph -n 10
git revert <commit_id>
git push

Hard reset to known-good version (aggressive):
git checkout main
git reset --hard v0.1-working-tts
git push --force-with-lease

---

# 5. Helpful commands

See commit history:
git log --oneline --decorate --graph -n 10

Check status:
git status

See differences:
git diff path/to/file.dart

See staged differences:
git diff --staged

---

# 6. Recommended habits for LegacyMVP

After each major success:
git add .
git commit -m "Working: <what works>"
git push
git tag -a v0.X -m "Checkpoint"
git push origin v0.X

Before risky changes:
git checkout -b feature-newthing

---

# End of Git Survival Sheet
