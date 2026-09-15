# Image generation for Pi

Choose an OpenRouter image model and turn a text description into an image without leaving Pi.

## What you can do

- Choose from OpenRouter's live image model list instead of a fixed shortlist.
- Generate directly with `/generate-image "prompt"`, or ask Pi in plain language.
- Review the model and prompt before spending API credits.
- Save model, ratio, resolution, output, and privacy preferences through `/setup-image-generation`.
- Save images locally and choose whether previews enter the conversation.

## Install

Requires Node.js 22.19 or later and Pi with extension dialog support. Set `OPENROUTER_API_KEY` in the environment that starts Pi, or enable fallback to Pi's existing OpenRouter credentials in setup. Do not paste your key into chat.

Once this package is published:

```bash
pi install npm:@firstpick/pi-extension-image-generation
```

## How to use it

Configure your preferences first:

```text
/setup-image-generation
```

Choose global settings or a trusted project profile. Set your default model, whether to ask for a model each time, supported ratio and resolution, output directory, and preview privacy. The connection check verifies credentials without generating a paid image. Choose **Save settings** when finished; closing the menu discards unsaved changes.

Then generate directly:

```text
/generate-image "create an image of a cat"
```

Choose an OpenRouter model, or use your saved default if you enabled that option. Confirm the prompt and wait for the saved image path. The command uses your prompt directly without asking the chat model to rewrite it or call tools. Quotation marks are optional.

To have Pi help with the prompt or image options, ask:

> Generate a watercolor illustration of a paper boat on a rainy city street. Show me the OpenRouter image models so I can choose. Use a wide aspect ratio if supported.

1. Pi calls `show_image_model_list` to open the model picker. Choose a model, or cancel.
2. Pi calls `generate_image_with_openrouter` with your choice and image description.
3. Review the prompt, model, options, and pricing link, then confirm or cancel.
4. Find the image in your configured output directory, which defaults to `generated-images/` under Pi's working directory. Pi returns its exact path and, if enabled, a preview when the image is small enough.

Each model choice permits one attempt. The conversational picker always asks; `/generate-image` can reuse your saved default. Every generation still requires final confirmation. Your normal chat model does not change.

You can also ask, "Show me only Google image models" to filter the picker.

## Before you start

- Generation sends the approved prompt to OpenRouter and its model provider and may spend your OpenRouter credits. Listing models does not generate an image.
- Prompts and returned previews enter the Pi session history. Previews may also reach your normal chat model. Choose **File paths only** in setup to omit image bytes from future results. This does not remove earlier previews or stop prompts from reaching the image provider.
- Settings never contain API keys. Project profiles replace all global preferences and apply only in trusted projects.
- This version supports text-to-image with PNG, JPEG, WebP, or GIF output. It does not upload reference images or support SVG vector output. Avoid vector-only models even if they appear in the live catalog.
- Cancelling a dialog sends no generation request. If a request fails or times out after sending, check OpenRouter activity before trying again.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for configuration, limits, compatibility, and troubleshooting. Contributors can use [DEVELOPMENT.md](DEVELOPMENT.md).
