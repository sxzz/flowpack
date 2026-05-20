import { nodeLib } from 'tsdown-preset-sxzz'
import tsnapi from 'tsnapi/rolldown'

export default nodeLib(
  {
    entry: ['src/index.ts', 'src/cli.ts'],
  },
  {
    plugins: [tsnapi()],
  },
)
