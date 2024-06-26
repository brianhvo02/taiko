import { Link } from 'react-router-dom';
import { forwardOne, previousOne, setElapsed, setDuration, setIsPlaying, setVolume, toggleRepeat, toggleShuffle, useAudio, toggleMute, useCurrentTrack, updateRemoteState } from '../store/audio';
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
import { useEffect, useRef, useState } from 'react';
import { secondsToTime } from '../utils';
import { useDispatch } from 'react-redux';
import { toggleRightSidebar } from '../store/layout';
import { AudioProps } from '../types/props';

const NowPlaying = ({ audio }: AudioProps) => {
    const { currentAudio, shuffleState, elapsed, duration, isPlaying, repeat, volume } = useAudio();
    const dispatch = useDispatch();
    const [seeker, setSeeker] = useState<number>();
    const firstLoad = useRef(true);
    const firstElapsed = useRef(0);

    useEffect(() => {
        firstElapsed.current = elapsed;
    }, [elapsed]);

    useEffect(() => {
        const audioEl = audio.current;
        audioEl.autoplay = true;

        const onPlay = () => {
            if (firstLoad.current && firstElapsed.current) { 
                audioEl.pause();
                audioEl.currentTime = firstElapsed.current;
            } else {
                dispatch(setIsPlaying(true));
            }

            firstLoad.current = false;
        };
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
            firstLoad.current = true;
            audioEl.autoplay = false;
            audioEl.removeEventListener('play', onPlay);
            audioEl.removeEventListener('pause', onPause);
            audioEl.removeEventListener('volumechange', onVolumeChange);
            audioEl.removeEventListener('timeupdate', onTimeUpdate);
            audioEl.removeEventListener('durationchange', onDurationChange);
            audioEl.removeEventListener('ended', onEnded);
        }
    }, [audio, dispatch]);
    
    const currentTrack = useCurrentTrack();

    useEffect(() => {
        if (!currentTrack) return;
        
        audio.current.src = `/api/tracks/${currentTrack.track_id}/audio`;
    }, [audio, currentTrack, dispatch]);

    useEffect(() => {
        audio.current.loop = repeat === 'one';
    }, [audio, repeat]);

    if (!currentAudio || !currentTrack) return null;

    return (
        <div className='now-playing'>
            <div className='track-meta'>
                {currentTrack.cover_file &&
                <img src={'/images/' + currentTrack.cover_file} alt='track cover'/>
                }
                <div className='track-info'>
                    <div className='track-title'>
                        <Link to={'/albums/' + currentTrack.album_id}>
                            {currentTrack.title}
                        </Link>
                    </div>
                    <Link to={'#'}>{currentTrack.artists.replaceAll(';', ', ')}</Link>
                </div>
            </div>
            <div className='player-controls'>
                <div className='control-buttons'>
                    <button 
                        onClick={() => dispatch(toggleShuffle())} 
                        className={shuffleState.active ? 'active' : ''}
                    ><ShuffleIcon />
                    </button>
                    <button
                        onClick={() => {
                            if (elapsed < 3)
                                return dispatch(previousOne());
                            
                            audio.current.currentTime = 0;
                        }} 
                        disabled={repeat === 'off' && currentAudio?.idx === 0}
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
                        disabled={repeat === 'off' && currentAudio.idx === currentAudio.tracks.length - 1}
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
                                updateRemoteState({ elapsed: val });
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
