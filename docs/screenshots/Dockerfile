FROM ubuntu:22.04

ARG SERVER_NAME=production

RUN apt-get update && apt-get install -y \
    openssh-server \
    sudo \
    vim \
    curl \
    git \
    htop \
    net-tools \
    procps \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir /var/run/sshd

# Create deploy user with password "demo"
RUN useradd -m -s /bin/bash deploy && \
    echo "deploy:demo" | chpasswd && \
    echo "deploy ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Allow password authentication
RUN sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config && \
    sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config

# Create realistic app structure
COPY setup-files.sh /tmp/setup-files.sh
RUN sed -i 's/\r$//' /tmp/setup-files.sh && chmod +x /tmp/setup-files.sh && bash /tmp/setup-files.sh ${SERVER_NAME}

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D"]
