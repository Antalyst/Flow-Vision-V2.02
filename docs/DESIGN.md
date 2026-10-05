---
name: Lumio Design System
colors:
  surface: '#fdf8f8'
  surface-dim: '#ddd9d9'
  surface-bright: '#fdf8f8'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f7f3f2'
  surface-container: '#f1edec'
  surface-container-high: '#ebe7e7'
  surface-container-highest: '#e5e2e1'
  on-surface: '#1c1b1b'
  on-surface-variant: '#46464a'
  inverse-surface: '#313030'
  inverse-on-surface: '#f4f0ef'
  outline: '#77767b'
  outline-variant: '#c7c6ca'
  surface-tint: '#5f5e60'
  primary: '#030304'
  on-primary: '#ffffff'
  primary-container: '#1d1d1f'
  on-primary-container: '#868587'
  inverse-primary: '#c8c6c8'
  secondary: '#5e5f5c'
  on-secondary: '#ffffff'
  secondary-container: '#e0e0dc'
  on-secondary-container: '#626360'
  tertiary: '#00030f'
  on-tertiary: '#ffffff'
  tertiary-container: '#001c44'
  on-tertiary-container: '#2a81ff'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e4e2e4'
  primary-fixed-dim: '#c8c6c8'
  on-primary-fixed: '#1b1b1d'
  on-primary-fixed-variant: '#474649'
  secondary-fixed: '#e3e2df'
  secondary-fixed-dim: '#c7c7c3'
  on-secondary-fixed: '#1b1c1a'
  on-secondary-fixed-variant: '#464744'
  tertiary-fixed: '#d8e2ff'
  tertiary-fixed-dim: '#adc6ff'
  on-tertiary-fixed: '#001a41'
  on-tertiary-fixed-variant: '#004493'
  background: '#fdf8f8'
  on-background: '#1c1b1b'
  surface-variant: '#e5e2e1'
typography:
  display:
    fontFamily: Inter
    fontSize: 80px
    fontWeight: '800'
    lineHeight: '1.1'
    letterSpacing: -0.04em
  h1:
    fontFamily: Inter
    fontSize: 48px
    fontWeight: '700'
    lineHeight: '1.2'
    letterSpacing: -0.03em
  h2:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '700'
    lineHeight: '1.3'
    letterSpacing: -0.02em
  h3:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.4'
    letterSpacing: -0.02em
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: '1.6'
    letterSpacing: -0.01em
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
    letterSpacing: '0'
  label-caps:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '600'
    lineHeight: '1'
    letterSpacing: 0.05em
  caption:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '500'
    lineHeight: '1.4'
    letterSpacing: '0'
rounded:
  sm: 0.5rem
  DEFAULT: 1rem
  md: 1.5rem
  lg: 2rem
  xl: 3rem
  full: 9999px
spacing:
  base: 8px
  xs: 4px
  sm: 12px
  md: 24px
  lg: 40px
  xl: 64px
  container-max: 1200px
  gutter: 24px
---

## Brand & Style

This design system is built for a premium creative ecosystem that balances professional power with playful energy. It draws inspiration from modern consumer electronics aesthetics—specifically the clarity and precision of Apple—while injecting a high-chroma vitality that resonates with creators. 

The style is a sophisticated blend of **Minimalism** and **Glassmorphism**. It utilizes expansive white space (specifically warm ivory) to let content breathe, while using translucent, frosted layers to create a sense of physical depth. The emotional response should be one of "effortless capability"—a tool that feels expensive and polished, yet inviting and ready for experimentation.

## Colors

The palette is anchored by a "Warm Ivory" (#FAF9F5) background, which provides a more organic, premium feel than a clinical pure white. Typography is set in "Deep Charcoal" (#1D1D1F) to ensure maximum legibility and a grounded, high-contrast look.

Energy is introduced through three signature gradients:
1.  **Electric Aura (Blue-to-Purple):** Used for primary actions and "power" features.
2.  **Sunset Vibe (Orange-to-Pink):** Used for creative highlights, notifications, and playful accents.
3.  **Emerald Pulse (Emerald-to-Teal):** Used for success states and growth-related metrics.

Functional neutrals should be derived from the Charcoal color with varying opacities rather than grey hex codes to maintain color harmony.

## Typography

The design system utilizes **Inter** for all typographic needs to ensure a clean, systematic, and highly legible experience across all platforms. 

Headlines are the voice of the brand: they must be bold and impactful with tight tracking (negative letter spacing) to create a "locked-in," professional editorial look. Large display sizes should use "Extra Bold" or "Black" weights. Body text remains functional and open, ensuring long-form readability. For small metadata or labels, a slight increase in tracking and uppercase transformation is used to create visual distinction from body copy.

## Layout & Spacing

This design system employs a **Fixed Grid** model for desktop and a fluid model for mobile. A 12-column grid is standard, with generous 24px gutters to reinforce the premium, airy aesthetic.

Spacing follows an 8px rhythmic scale. Wide margins (64px+) are encouraged for marketing and high-level dashboard views to emphasize the Ivory background. Content should be grouped logically into containers, using the 'lg' and 'xl' spacing tokens to separate major sections, creating a clear visual hierarchy through "breathing room."

## Elevation & Depth

Hierarchy is established through **Glassmorphism** and soft, ambient shadows. Rather than using harsh borders, depth is created by stacking translucent layers over the warm ivory base.

- **Surface Level 0:** The Warm Ivory background.
- **Surface Level 1 (Cards):** White at 70% opacity with a 20px-40px Backdrop Blur. A subtle 0.5px white inner stroke (border) simulates a glass edge.
- **Surface Level 2 (Modals/Popovers):** Higher opacity white (90%) with a more pronounced, diffused shadow (Blur: 30px, Y: 10, Opacity: 5% Charcoal).

Shadows should never be pure black; they should always be a low-opacity tint of the Charcoal text color to maintain a natural, photographic depth.

## Shapes

The design system uses a **Pill-shaped (Level 3)** roundedness philosophy. This "large radius" approach is a hallmark of the playful-yet-premium aesthetic, making the software feel approachable and ergonomic.

- **Small Components (Buttons, Inputs):** Use a 1rem (16px) radius or full pill shape.
- **Medium Components (Cards):** Use a 2rem (32px) radius.
- **Large Containers:** Use a 3rem (48px) radius.

Consistency in corner radii is critical; always ensure nested elements have a proportional radius (inner radius = outer radius - padding) to maintain geometric harmony.

## Components

### Buttons
Primary buttons should use one of the three signature gradients with white text. They should have a subtle drop shadow that inherits the color of the gradient (tinted shadow) to make them appear as if they are glowing. Secondary buttons use a glassmorphic style with charcoal text.

### Cards
Cards are the primary content vehicle. They must feature a backdrop blur and a large corner radius. For creative content, cards should use "Edge-to-Edge" imagery where the photo or video fills the top half of the card, bleeding into the rounded corners.

### Input Fields
Inputs should be clean and minimalist. A subtle ivory-tinted fill with a 1px border that becomes one of the signature gradients on focus. Typography within inputs should be crisp Inter Medium.

### Chips & Tags
Small, pill-shaped elements with high-saturation background tints (at 10-15% opacity) and dark text. These are used for categorization and filtering without adding visual clutter.

### Playful Imagery
Incorporate 3D assets or high-quality photography that features vibrant colors and clean lighting. Imagery should often "break the container," overlapping card edges slightly to enhance the sense of depth and creativity.