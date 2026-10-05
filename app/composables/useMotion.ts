import { gsap } from 'gsap'

/** GSAP motion shared by components: JS hooks for <Transition :css="false"> and a number tween. */

const reduced = () => import.meta.client && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Dialog: backdrop fades, panel springs up. Expects `[data-backdrop]` and `[data-panel]` inside the element. */
export const modalMotion = {
  onEnter(el: Element, done: () => void) {
    if (reduced()) return done()
    gsap
      .timeline({ onComplete: done })
      .from(el.querySelector('[data-backdrop]'), { opacity: 0, duration: 0.25, ease: 'power1.out' })
      .from(el.querySelector('[data-panel]'), { opacity: 0, y: 40, scale: 0.96, duration: 0.5, ease: 'back.out(1.6)' }, 0)
  },
  onLeave(el: Element, done: () => void) {
    if (reduced()) return done()
    gsap
      .timeline({ onComplete: done })
      .to(el.querySelector('[data-panel]'), { opacity: 0, y: 24, scale: 0.97, duration: 0.2, ease: 'power2.in' })
      .to(el.querySelector('[data-backdrop]'), { opacity: 0, duration: 0.2 }, 0)
  },
}

/** Toasts: slide in from the right with a little overshoot, collapse away. */
export const toastMotion = {
  onEnter(el: Element, done: () => void) {
    if (reduced()) return done()
    gsap.from(el, { opacity: 0, x: 48, scale: 0.95, duration: 0.55, ease: 'back.out(1.7)', onComplete: done })
  },
  onLeave(el: Element, done: () => void) {
    if (reduced()) return done()
    gsap.to(el, { opacity: 0, x: 48, height: 0, marginTop: 0, paddingTop: 0, paddingBottom: 0, duration: 0.3, ease: 'power2.in', onComplete: done })
  },
}

/** A number that counts up to its target whenever the target changes. Non-numbers pass straight through. */
export function useCountUp(source: () => string | number | null | undefined) {
  const shown = ref<string | number | null | undefined>(source())
  watch(
    source,
    (to, from) => {
      if (typeof to !== 'number' || reduced()) return void (shown.value = to)
      const state = { v: typeof from === 'number' ? from : 0 }
      gsap.to(state, { v: to, duration: 1.1, ease: 'power3.out', onUpdate: () => (shown.value = Math.round(state.v)) })
    },
    { flush: 'post' },
  )
  onMounted(() => {
    const to = source()
    if (typeof to !== 'number' || reduced() || to === 0) return
    const state = { v: 0 }
    shown.value = 0
    gsap.to(state, { v: to, duration: 1.2, ease: 'power3.out', onUpdate: () => (shown.value = Math.round(state.v)) })
  })
  return shown
}
