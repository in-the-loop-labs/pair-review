# Frontend JS Conventions

## No nested interactive elements

HTML spec forbids nesting interactive content inside interactive elements (e.g. `<button>` inside `<button>`). Browsers enforce this by stripping the inner element from the DOM during parsing -- it will not render at all.

When you need a clickable element inside a `<button>`, use a `<span>` instead:

```html
<button class="outer-action">
  Label
  <span role="button" tabindex="-1" class="inner-action">X</span>
</button>
```

The `<span>` handler must call `event.stopPropagation()` to prevent the outer button's click from firing.
