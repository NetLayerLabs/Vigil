import React from "react";
import { Composition, Still } from "remotion";
import { Poster } from "./Poster";
import { Film } from "./Film";
import { T } from "./timing";

export const Root: React.FC = () => (
  <>
    <Composition id="Vigil" component={Film} durationInFrames={T.totalFrames} fps={T.fps} width={1920} height={1080} />
    <Still id="Poster" component={Poster} width={1920} height={1080} />
  </>
);
