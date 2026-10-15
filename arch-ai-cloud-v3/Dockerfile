# Build once, push to your own registry, reuse on GPU rental hosts.
# This image contains ComfyUI + runtime dependencies, but NO giant model weights.
FROM pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/workspace/.cache/huggingface \
    XDG_CACHE_HOME=/workspace/.cache \
    COMFY_HOME=/opt/ComfyUI \
    WORKSPACE=/workspace

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates ffmpeg libgl1 libglib2.0-0 tini \
    && rm -rf /var/lib/apt/lists/*

ARG COMFY_REF=master
RUN git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git /opt/ComfyUI \
    && if [ "$COMFY_REF" != "master" ]; then cd /opt/ComfyUI && git fetch --depth 1 origin "$COMFY_REF" && git checkout FETCH_HEAD; fi \
    && python -m pip install -r /opt/ComfyUI/requirements.txt \
    && python -m pip install 'huggingface_hub[cli]>=0.25,<2' requests

COPY scripts/start.sh /usr/local/bin/arch-ai-start
COPY scripts/download-models.py /usr/local/bin/arch-ai-models
COPY scripts/install-custom-nodes.sh /usr/local/bin/arch-ai-install-nodes
COPY config/models-example.json /opt/models-example.json
RUN chmod +x /usr/local/bin/arch-ai-start /usr/local/bin/arch-ai-models /usr/local/bin/arch-ai-install-nodes

WORKDIR /workspace
EXPOSE 8188
ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/arch-ai-start"]
