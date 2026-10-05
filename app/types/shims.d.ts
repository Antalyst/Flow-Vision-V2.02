declare module 'feather-icons' {
  interface FeatherIcon {
    toSvg(attrs?: Record<string, string | number>): string
  }
  const feather: { icons: Record<string, FeatherIcon> }
  export default feather
}
