import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import type { Directive } from 'vue'

/**
 * GSAP for the whole app.
 *
 *  - Every page: when a page finishes rendering, its top-level sections rise in with a short stagger.
 *  - v-reveal: fade + rise when the element scrolls into view. `v-reveal="{ stagger: 0.08 }"` animates its children instead.
 *  - v-magnetic: the element leans a little toward the pointer (buttons, CTAs).
 *
 * Hidden-before-reveal is done in CSS (`.fv-js [data-reveal]`), so server-rendered content never flashes.
 * People who prefer reduced motion get everything immediately.
 */

interface RevealOptions {
  y?: number
  delay?: number
  stagger?: number
  /** Animate when the element enters the viewport (default) or right away. */
  scroll?: boolean
}

const reducedMotion = () => import.meta.client && window.matchMedia('(prefers-reduced-motion: reduce)').matches

function reveal(el: HTMLElement, opts: RevealOptions = {}) {
  const targets = opts.stagger ? (Array.from(el.children) as HTMLElement[]) : [el]
  if (opts.stagger) gsap.set(el, { opacity: 1 })
  if (reducedMotion()) {
    gsap.set(targets, { opacity: 1, y: 0 })
    return
  }
  gsap.fromTo(
    targets,
    { opacity: 0, y: opts.y ?? 28 },
    {
      opacity: 1,
      y: 0,
      duration: 0.9,
      ease: 'power3.out',
      delay: opts.delay ?? 0,
      stagger: opts.stagger ?? 0,
      clearProps: 'transform',
      scrollTrigger: opts.scroll === false ? undefined : { trigger: el, start: 'top 88%', once: true },
    },
  )
}

const revealDirective: Directive<HTMLElement, RevealOptions | undefined> = {
  getSSRProps: () => ({ 'data-reveal': '' }),
  mounted(el, { value }) {
    el.setAttribute('data-reveal', '')
    reveal(el, value ?? {})
  },
}

const magneticDirective: Directive<HTMLElement, number | undefined> = {
  mounted(el, { value }) {
    if (reducedMotion() || !window.matchMedia('(pointer: fine)').matches) return
    const strength = value ?? 0.25
    const x = gsap.quickTo(el, 'x', { duration: 0.5, ease: 'power3.out' })
    const y = gsap.quickTo(el, 'y', { duration: 0.5, ease: 'power3.out' })
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      x((e.clientX - (r.left + r.width / 2)) * strength)
      y((e.clientY - (r.top + r.height / 2)) * strength)
    }
    const leave = () => {
      x(0)
      y(0)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerleave', leave)
    ;(el as HTMLElement & { _fvMagnetic?: () => void })._fvMagnetic = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerleave', leave)
    }
  },
  unmounted(el) {
    ;(el as HTMLElement & { _fvMagnetic?: () => void })._fvMagnetic?.()
  },
}

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.directive('reveal', revealDirective)
  nuxtApp.vueApp.directive('magnetic', magneticDirective)

  if (import.meta.server) return

  gsap.registerPlugin(ScrollTrigger)

  // Page enter: the sections of whatever page just rendered rise in, one after another.
  // Skipped for the first (server-rendered) page, which is already on screen.
  let firstPage = true
  nuxtApp.hook('page:finish', () => {
    requestAnimationFrame(() => {
      ScrollTrigger.refresh()
      if (firstPage) {
        firstPage = false
        return
      }
      const root = document.querySelector<HTMLElement>('[data-page-enter]')
      if (!root || reducedMotion()) return
      const page = root.firstElementChild as HTMLElement | null
      const sections = Array.from((page?.children.length ? page.children : root.children) as HTMLCollectionOf<HTMLElement>)
        .filter((s) => !s.hasAttribute('data-reveal'))
        .slice(0, 10)
      gsap.fromTo(sections, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out', stagger: 0.06, clearProps: 'opacity,transform' })
    })
  })

  return { provide: { gsap, ScrollTrigger } }
})
