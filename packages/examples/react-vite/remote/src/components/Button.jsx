
import "./Button.css"

import React from "react"
import { createWithEqualityFn, traditionalReact, withSelectorReact } from "store-lib/traditional"

// store-lib/traditional is a sub-path of the shared `store-lib` package: it is
// bundled into this remote, but its ESM `import React` and its CJS helper's
// `require('react')` must both resolve to the host-provided React instance.
const useCounter = createWithEqualityFn((set) => ({
  count: 0,
  increment: () => set((s) => ({ count: s.count + 1 }))
}))

export const Button = () => {
  const count = useCounter((s) => s.count)
  const increment = useCounter((s) => s.increment)
  const sharedReact = traditionalReact === React && withSelectorReact === React
  return (
    <div>
      <button
        id='click-btn'
        className='shared-btn'
        data-shared-react={String(sharedReact)}
        onClick={increment}
      >
        Click me: {count}
      </button>
    </div>
  )
}

export default Button
