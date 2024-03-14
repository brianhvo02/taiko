import { Link } from 'react-router-dom';
import { forwardOne, previousOne, setElapsed, setDuration, setIsPlaying, setVolume, toggleRepeat, toggleShuffle, useAudio, toggleMute } from '../store/audio';
import './NowPlaying.scss';
import { Slider } from '@mui/material';
import SkipPreviousIcon from '@mui/icons-material/SkipPrevious';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import PlayIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import ShuffleIcon from '@mui/icons-material/Shuffle';
import RepeatIcon from '@mui/icons-material/Repeat';
import RepeatOneIcon from '@mui/icons-material/RepeatOne';
import VideoLibraryIcon from '@mui/icons-material/VideoLibrary';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import VolumeDownIcon from '@mui/icons-material/VolumeDown';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import { useEffect, useState } from 'react';
import { secondsToTime } from '../utils';
import { useDispatch } from 'react-redux';
import { toggleRightSidebar } from '../store/layout';

const NowPlaying = ({ audio }: AudioProps) => {
    const { currentAudio, elapsed, duration, isPlaying, shuffle, repeat, volume } = useAudio();
    const dispatch = useDispatch();
    const [seeker, setSeeker] = useState<number>();

    useEffect(() => {
        const audioEl = audio.current;
        audioEl.autoplay = true;

        const onPlay = () => dispatch(setIsPlaying(true));
        const onPause = () => dispatch(setIsPlaying(false));
        const onVolumeChange = () => dispatch(setVolume(audio.current.volume * 100));
        const onTimeUpdate = () => dispatch(setElapsed(audio.current.currentTime));
        const onDurationChange = () => dispatch(setDuration(audio.current.duration));
        const onEnded = () => dispatch(forwardOne(false));

        audioEl.addEventListener('play', onPlay);
        audioEl.addEventListener('pause', onPause);
        audioEl.addEventListener('volumechange', onVolumeChange);
        audioEl.addEventListener('timeupdate', onTimeUpdate);
        audioEl.addEventListener('durationchange', onDurationChange);
        audioEl.addEventListener('ended', onEnded);

        return () => {
            audioEl.autoplay = false;
            audioEl.removeEventListener('play', onPlay);
            audioEl.removeEventListener('pause', onPause);
            audioEl.removeEventListener('volumechange', onVolumeChange);
            audioEl.removeEventListener('timeupdate', onTimeUpdate);
            audioEl.removeEventListener('durationchange', onDurationChange);
            audioEl.removeEventListener('ended', onEnded);
        }
    }, [audio, dispatch]);

    useEffect(() => {
        if (!currentAudio) return;
        
        audio.current.src = `/api/tracks/${currentAudio.track.track_id}/audio`;
    }, [audio, currentAudio, dispatch]);

    useEffect(() => {
        audio.current.loop = repeat === 'one';
    }, [audio, repeat]);

    if (!currentAudio) return null;

    const { track, trackList, idx } = currentAudio;

    return (
        <div className='now-playing'>
            <div className='track-meta'>
                {track.cover_file &&
                <img src={'/images/' + track.cover_file} alt='track cover'/>
                }
                <div className='track-info'>
                    <div className='track-title'>
                        <Link to={'/albums/' + track.album_id}>
                            {track.title}
                        </Link>
                    </div>
                    <Link to={'#'}>{track.album_artist}</Link>
                </div>
            </div>
            <div className='player-controls'>
                <div className='control-buttons'>
                    <button 
                        onClick={() => dispatch(toggleShuffle())} 
                        className={shuffle ? 'active' : ''}
                    ><ShuffleIcon />
                    </button>
                    <button
                        onClick={() => {
                            if (elapsed < 3)
                                return dispatch(previousOne());
                            
                            audio.current.currentTime = 0;
                        }} 
                        disabled={repeat === 'off' && idx === 0}
                    ><SkipPreviousIcon />
                    </button>
                    <button>
                        { isPlaying ?
                        <PauseIcon onClick={() => audio.current.pause()} /> :
                        <PlayIcon onClick={() => audio.current.play()} />
                        }
                    </button>
                    <button 
                        onClick={() => dispatch(forwardOne(true))} 
                        disabled={repeat === 'off' && idx === trackList.length - 1}
                    ><SkipNextIcon />
                    </button>
                    <button 
                        onClick={() => dispatch(toggleRepeat())}
                        className={repeat !== 'off' ? 'active' : ''}
                    >
                        { repeat === 'one' ?
                        <RepeatOneIcon /> :
                        <RepeatIcon /> }
                    </button>
                </div>
                <div className='progress'>
                    <p>{secondsToTime(seeker ?? elapsed)}</p>
                    <Slider
                        size='small'
                        value={seeker ?? elapsed}
                        max={duration}
                        onChange={(_, val) => {
                            if (!Array.isArray(val))
                                setSeeker(val);
                        }}
                        onChangeCommitted={(_, val) => { 
                            if (audio.current && !Array.isArray(val)) {
                                audio.current.currentTime = val;
                                setSeeker(undefined);
                            }
                        }} 
                    />
                    <p>{secondsToTime(duration)}</p>
                </div>
            </div>
            <div className='player-options'>
                <button>
                    <VideoLibraryIcon onClick={() => dispatch(toggleRightSidebar())} />
                </button>
                <div className='volume-slider'>
                    <button onClick={() => dispatch(toggleMute(audio))}>
                        { volume === 0 ?
                        <VolumeOffIcon /> :
                        volume < 50 ?
                        <VolumeDownIcon /> :
                        <VolumeUpIcon /> }
                    </button>
                    <Slider
                        size='small'
                        value={volume}
                        max={100}
                        onChange={(_, val) => {
                            if (!Array.isArray(val))
                                audio.current.volume = val / 100;
                        }}
                    />
                </div>
                <button>
                    <FullscreenIcon />
                </button>
            </div>
        </div>
    );
}

export default NowPlaying;
