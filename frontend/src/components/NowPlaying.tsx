import { Link } from 'react-router-dom';
import { forwardOne, previousOne, setElapsed, setIsPlaying, setVolume, toggleIsPlaying, toggleRepeat, toggleShuffle, useAudio } from '../store/audio';
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
import { Howl, HowlOptions } from 'howler';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { secondsToTime } from '../utils';
import { useDispatch } from 'react-redux';

const NowPlaying = () => {
    const audio = useRef<Howl | null>(null);
    const { currentAudio, elapsed, isPlaying, shuffle, repeat, volume } = useAudio();
    const dispatch = useDispatch();
    const requestRef = useRef(0);
    const lastTime = useRef(0);
    const [seeker, setSeeker] = useState<number>();
  
    const animate: FrameRequestCallback = useCallback(time => {
        if (audio.current?.playing() && time - lastTime.current > 100) {
            dispatch(setElapsed(audio.current.seek()));
            lastTime.current = time;
        }

        requestRef.current = requestAnimationFrame(animate);
    }, [dispatch]);

    const howlOptions = useMemo<Omit<HowlOptions, 'src'>>(() => ({
        html5: true,
        onload: () => dispatch(setIsPlaying(true)),
        onend: () => dispatch(forwardOne(false)),
    }), [dispatch]);

    const createOnLoadError = useCallback((trackId: string) => () => {
        audio.current?.unload();
        audio.current = new Howl({
            ...howlOptions,
            src: `/audio/${trackId}.webm`,
            onloaderror: console.error,
        });
    }, [howlOptions]);

    useEffect(() => {
        if (!currentAudio) return;
        if (requestRef.current)
            cancelAnimationFrame(requestRef.current);

        requestRef.current = requestAnimationFrame(animate);

        audio.current = new Howl({ 
            ...howlOptions,
            src: `/api/tracks/${currentAudio.track._id}/audio${currentAudio.track.ext}`,
            onloaderror: createOnLoadError(currentAudio.track._id),
        });

        return () => {
            cancelAnimationFrame(requestRef.current);
            audio.current?.unload();
            dispatch(setIsPlaying(false));
        };
    }, [currentAudio, animate, howlOptions, dispatch, createOnLoadError]);

    useEffect(() => {
        if (isPlaying) {
            audio.current?.play();
        } else {
            audio.current?.pause();
        }
    }, [isPlaying]);

    useEffect(() => {
        audio.current?.loop(repeat === 'one');
    }, [repeat]);

    useEffect(() => {
        audio.current?.volume(volume / 100);
    }, [volume]);

    if (!currentAudio) return null;

    const { track, album, trackList, idx } = currentAudio;

    return (
        <div className='now-playing'>
            <div className='track-meta'>
                {track.cover &&
                <img src={'/images/' + track.cover} alt='track cover'/>
                }
                <div className='track-info'>
                    <div className='track-title'>
                        <Link to={'/albums/' + album._id}>
                            {track.title}
                        </Link>
                    </div>
                    <Link to={'#'}>{album.artist}</Link>
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
                            
                            audio.current?.seek(0);
                            dispatch(setElapsed(0));
                        }} 
                        disabled={repeat === 'off' && idx === 0}
                    ><SkipPreviousIcon />
                    </button>
                    <button onClick={() => dispatch(toggleIsPlaying())}>
                        {isPlaying ?
                        <PauseIcon /> :
                        <PlayIcon />}
                    </button>
                    <button 
                        onClick={() => dispatch(forwardOne(true))} 
                        disabled={repeat === 'off' && idx === trackList.length - 1}
                    ><SkipNextIcon />
                    </button>
                    <button 
                        onClick={() => dispatch(toggleRepeat())}
                        className={repeat !== 'off' ? 'active' : ''}
                    >{repeat === 'one' ?
                        <RepeatOneIcon /> :
                        <RepeatIcon />}
                    </button>
                </div>
                <div className='progress'>
                    <p>{secondsToTime(seeker ?? elapsed)}</p>
                    <Slider
                        size='small'
                        value={seeker ?? elapsed}
                        max={track.duration}
                        onChange={(_, val) => {
                            if (!Array.isArray(val))
                                setSeeker(val);
                        }}
                        onChangeCommitted={(_, val) => { 
                            if (audio.current && !Array.isArray(val)) {
                                audio.current.seek(val);
                                dispatch(setElapsed(val));
                                setSeeker(undefined);
                            }
                        }} 
                    />
                    <p>{secondsToTime(track.duration)}</p>
                </div>
            </div>
            <div className='player-options'>
                <button>
                    <VideoLibraryIcon />
                </button>
                <div className='volume-slider'>
                    <button onClick={() => dispatch(setVolume(0))}>
                        {volume === 0 ?
                        <VolumeOffIcon /> :
                        volume < 50 ?
                        <VolumeDownIcon /> :
                        <VolumeUpIcon />}
                    </button>
                    <Slider
                        size='small'
                        value={volume}
                        max={100}
                        onChange={(_, val) => {
                            if (!Array.isArray(val))
                                dispatch(setVolume(val));
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
