# Writing captions for non-technical viewers

The video has no voice. The captions are the explanation. Someone who has never seen the product should be able to read them in order, with the picture turned off, and know what the product does and how to start.

## Shape of a caption

**Bold lead** + grey rest.

- The lead is the action or the point, one to four words: "Type a name", "Press Space", "One click", "Check what will change".
- The rest says what the viewer gets, in five or six words: "to find any app.", "shows every update."
- Ten words at most. The validator warns above ten and fails above fourteen.
- End with a full stop. Captions are sentences.

Read the lead alone. If it still makes sense ("Press Space"), the caption works for people who only skim.

## Word choice

Say what something does, not what it is called.

| Instead of | Write |
| --- | --- |
| Configure the AUR helper | Choose where community apps come from |
| Preflight shows dependency conflicts | Check what will change before it happens |
| Sync the repository databases | Get the latest list of apps |
| Toggle the modal | Open the window |
| Enqueue packages | Add apps to your list |
| Authenticate via OAuth | Sign in in your browser |

Use the product's name and the names of buttons the viewer will actually see on screen. Everything else should be everyday language. If a term is unavoidable and your audience knows it ("Arch" for an Arch Linux tool), add it to `allowTerms`.

Cut words that add nothing:

- Filler: simply, just, easily, quickly, actually.
- Hype: powerful, seamless, robust, revolutionary, effortless.
- Hedging: can help you, allows you to, makes it possible to.

"Pacsea allows you to easily search for packages" becomes "**Type a name** to find any app."

## Order of steps

Follow the order a first-time user works in. Usually: find or open something, look at it, act on it, confirm the result. End on the payoff, not on settings.

Number the steps. The numbers tell the viewer how far along they are.

## Check before rendering

- Read all captions aloud in order. Do they tell one story?
- Does each one name a single action?
- Would your least technical friend understand every word?
- Does every claim match what the product does? Check the docs or source.
