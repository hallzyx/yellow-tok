import { Routes, Route } from 'react-router-dom'
import { Layout } from './components/Layout'
import { HomePage } from './pages/HomePage'
import { StreamerPage } from './pages/StreamerPage'
import LandingPage from './pages/LandingPage'
import { YellowProvider } from './hooks/useYellow'


export default function App() {
  return (
    <YellowProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/home" element={<HomePage />} />
          <Route path="/streamer/:ensName" element={<StreamerPage />} />
          <Route path="/" element={<LandingPage />} />
        </Route>
      </Routes>
    </YellowProvider>
  )
}
