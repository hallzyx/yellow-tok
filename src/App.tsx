import { Routes, Route } from 'react-router-dom'
import { Layout } from './components/Layout'
import { HomePage } from './pages/HomePage'
import { StreamerPage } from './pages/StreamerPage'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/streamer/:ensName" element={<StreamerPage />} />
      </Route>
    </Routes>
  )
}
